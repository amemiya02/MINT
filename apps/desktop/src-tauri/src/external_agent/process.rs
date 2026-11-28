use std::io;
use std::process::{Child, Command, ExitStatus};

pub(super) struct AgentProcess {
    child: Child,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}

impl AgentProcess {
    pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            command.spawn().map(|child| Self { child })
        }
        #[cfg(windows)]
        {
            windows::spawn(command)
        }
    }

    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Ok(group) = i32::try_from(self.child.id()) {
            // Kill sandbox commands and tools even if the CLI already exited.
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
        #[cfg(windows)]
        drop(self.job.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use std::ptr;
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::{Diagnostics::ToolHelp::*, JobObjects::*, Threading::*};

    pub(super) fn spawn(command: &mut Command) -> io::Result<AgentProcess> {
        let job = handle(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                ptr::from_ref(&limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }

        // Attach before executing any of the Agent's code, including its tool startup.
        let child = command
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
            .spawn()?;
        let process = AgentProcess {
            child,
            job: Some(job),
        };
        if unsafe {
            AssignProcessToJobObject(
                process.job.as_ref().unwrap().as_raw_handle(),
                process.child.as_raw_handle(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        resume_main_thread(process.child.id())?;
        Ok(process)
    }

    fn handle(raw: HANDLE) -> io::Result<OwnedHandle> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
        }
    }

    fn resume_main_thread(pid: u32) -> io::Result<()> {
        let snapshot = handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread =
                    handle(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) })?;
                return if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                };
            }
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        Err(io::Error::other("Agent's suspended thread was not found"))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    #[test]
    fn stopping_the_agent_kills_its_running_tool() {
        let scratch = tempfile::tempdir().unwrap();
        let mut command = Command::new("/bin/sh");
        command.current_dir(scratch.path()).args([
            "-c",
            "(touch ready; while [ ! -f release ]; do sleep .01; done; touch survived) & wait",
        ]);
        let process = AgentProcess::spawn(&mut command).unwrap();
        let started = Instant::now();
        while !scratch.path().join("ready").exists() {
            assert!(started.elapsed() < Duration::from_secs(3));
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(process);
        fs::write(scratch.path().join("release"), b"ready").unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(!scratch.path().join("survived").exists());
    }
}
