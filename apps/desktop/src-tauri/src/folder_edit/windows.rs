use super::*;
use std::fs::{self, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::Arc;
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    MOVEFILE_WRITE_THROUGH,
};

pub(super) struct Directory {
    path: PathBuf,
    handles: Vec<Arc<File>>,
}

impl Directory {
    pub(super) fn open(path: &Path) -> io::Result<Self> {
        let mut directory = Self {
            path: PathBuf::new(),
            handles: Vec::new(),
        };
        let mut components = path.components();
        match (components.next(), components.next()) {
            (Some(Component::Prefix(prefix)), Some(Component::RootDir)) => {
                directory.path.push(prefix.as_os_str());
                directory.path.push(Path::new("\\"));
                directory.lock()?;
            }
            _ => return Err(outside()),
        }
        for component in components {
            let Component::Normal(name) = component else {
                return Err(outside());
            };
            directory = directory.child(name, false)?;
        }
        Ok(directory)
    }

    pub(super) fn duplicate(&self) -> io::Result<Self> {
        Ok(Self {
            path: self.path.clone(),
            handles: self.handles.clone(),
        })
    }

    pub(super) fn child(&self, name: &OsStr, create: bool) -> io::Result<Self> {
        let mut child = self.duplicate()?;
        child.path.push(name);
        match child.lock() {
            Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(&child.path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
                child.lock()?;
            }
            other => other?,
        }
        Ok(child)
    }

    fn lock(&mut self) -> io::Result<()> {
        let directory = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&self.path)?;
        let metadata = directory.metadata()?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(outside());
        }
        self.handles.push(Arc::new(directory));
        Ok(())
    }

    pub(super) fn read(&self, name: &OsStr) -> io::Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(self.path.join(name))?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(outside());
        }
        Ok(file)
    }

    pub(super) fn create(&self, name: &OsStr) -> io::Result<File> {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path.join(name))
    }

    pub(super) fn remove(&self, name: &OsStr) -> io::Result<()> {
        fs::remove_file(self.path.join(name))
    }

    pub(super) fn move_to(
        &self,
        name: &OsStr,
        destination: &Self,
        target: &OsStr,
    ) -> io::Result<()> {
        let from = wide(&self.path.join(name));
        let to = wide(&destination.path.join(target));
        for retry in 0..=20 {
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if retry == 20 || !matches!(error.raw_os_error(), Some(5 | 32 | 33)) {
                return Err(error);
            }
            std::thread::sleep(std::time::Duration::from_millis(3 * (retry + 1)));
        }
        unreachable!()
    }

    pub(super) fn sync(&self) {
        // MoveFileExW uses MOVEFILE_WRITE_THROUGH for publication.
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
