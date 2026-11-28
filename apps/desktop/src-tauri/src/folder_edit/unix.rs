use super::*;
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;

#[derive(Debug)]
pub(super) struct Directory(File);

impl Directory {
    pub(super) fn open(path: &Path) -> io::Result<Self> {
        let mut directory = Self(File::open("/")?);
        if !path.is_absolute() {
            return Err(outside());
        }
        for component in path.components().skip(1) {
            let Component::Normal(name) = component else {
                return Err(outside());
            };
            directory = directory.child(name, false)?;
        }
        Ok(directory)
    }

    pub(super) fn duplicate(&self) -> io::Result<Self> {
        self.0.try_clone().map(Self)
    }

    pub(super) fn child(&self, name: &OsStr, create: bool) -> io::Result<Self> {
        let name = cstring(name)?;
        let open = || {
            self.open_at(
                &name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
                0,
            )
        };
        match open() {
            Ok(file) => Ok(Self(file)),
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                if let Err(error) =
                    checked(unsafe { libc::mkdirat(self.fd(), name.as_ptr(), 0o777) })
                {
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(error);
                    }
                }
                let child = open().map(Self)?;
                self.sync();
                Ok(child)
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn read(&self, name: &OsStr) -> io::Result<File> {
        let file = self.open_at(
            &cstring(name)?,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0,
        )?;
        if !file.metadata()?.is_file() {
            return Err(outside());
        }
        Ok(file)
    }

    pub(super) fn create(&self, name: &OsStr) -> io::Result<File> {
        self.open_at(
            &cstring(name)?,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
    }

    pub(super) fn remove(&self, name: &OsStr) -> io::Result<()> {
        checked(unsafe { libc::unlinkat(self.fd(), cstring(name)?.as_ptr(), 0) })
    }

    pub(super) fn move_to(
        &self,
        name: &OsStr,
        destination: &Self,
        target: &OsStr,
    ) -> io::Result<()> {
        rename(
            self.fd(),
            &cstring(name)?,
            destination.fd(),
            &cstring(target)?,
            false,
        )
    }

    pub(super) fn exchange(&self, first: &OsStr, second: &OsStr) -> io::Result<()> {
        rename(
            self.fd(),
            &cstring(first)?,
            self.fd(),
            &cstring(second)?,
            true,
        )
    }

    pub(super) fn sync(&self) {
        let _ = self.0.sync_all();
    }

    fn fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }

    fn open_at(&self, name: &CString, flags: libc::c_int, mode: libc::c_uint) -> io::Result<File> {
        let fd = unsafe { libc::openat(self.fd(), name.as_ptr(), flags | libc::O_CLOEXEC, mode) };
        checked(fd)?;
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

fn cstring(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| outside())
}

fn checked(result: libc::c_int) -> io::Result<()> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn rename(
    from: RawFd,
    name: &CString,
    to: RawFd,
    target: &CString,
    exchange: bool,
) -> io::Result<()> {
    let flags = if exchange {
        libc::RENAME_EXCHANGE
    } else {
        libc::RENAME_NOREPLACE
    };
    checked(unsafe { libc::renameat2(from, name.as_ptr(), to, target.as_ptr(), flags) })
}

#[cfg(target_os = "macos")]
fn rename(
    from: RawFd,
    name: &CString,
    to: RawFd,
    target: &CString,
    exchange: bool,
) -> io::Result<()> {
    let flags = if exchange {
        libc::RENAME_SWAP
    } else {
        libc::RENAME_EXCL
    };
    checked(unsafe { libc::renameatx_np(from, name.as_ptr(), to, target.as_ptr(), flags) })
}
