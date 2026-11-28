//! Checked writes for a reviewed working-folder task. These operations never
//! reopen a validated Unix parent by name. On Windows, every parent stays locked
//! against rename and reparse points are refused while the write is in flight.
use std::ffi::{OsStr, OsString};
use std::fs::{File, Permissions};
use std::io::{self, Read, Write};
use std::path::{Component, Path};

#[cfg(unix)]
#[path = "folder_edit/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "folder_edit/windows.rs"]
mod platform;

use platform::Directory;

pub(crate) struct Edit<'a> {
    source: Entry<'a>,
    destination: Entry<'a>,
    in_place: bool,
}

struct Entry<'a> {
    parent: Directory,
    name: &'a OsStr,
}

impl<'a> Entry<'a> {
    fn open(root: &Directory, relative: &'a Path, create_parents: bool) -> io::Result<Self> {
        let parent = relative.parent().ok_or_else(outside)?;
        let name = relative.file_name().ok_or_else(outside)?;
        let mut directory = root.duplicate()?;
        for part in parent.components() {
            let Component::Normal(name) = part else {
                return Err(outside());
            };
            directory = directory.child(name, create_parents)?;
        }
        Ok(Self {
            parent: directory,
            name,
        })
    }

    fn matches(&self, name: &OsStr, expected: &[u8]) -> io::Result<Permissions> {
        let mut file = self.parent.read(name)?;
        let metadata = file.metadata()?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(expected.len() as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes != expected {
            return Err(conflict());
        }
        Ok(metadata.permissions())
    }

    fn stage(&self, text: &[u8], permissions: Option<Permissions>) -> io::Result<OsString> {
        let name = scratch_name();
        let mut file = self.parent.create(&name)?;
        let result = (|| {
            file.write_all(text)?;
            if let Some(permissions) = permissions {
                file.set_permissions(permissions)?;
            }
            file.sync_all()
        })();
        drop(file);
        if let Err(error) = result {
            let _ = self.parent.remove(&name);
            return Err(error);
        }
        Ok(name)
    }

    fn restore(&self, backup: &OsStr, reason: io::Error) -> io::Error {
        if let Err(error) = self.parent.move_to(backup, &self.parent, self.name) {
            io::Error::other(format!(
                "{reason}; could not restore ({error}); saved as {backup:?} beside the document"
            ))
        } else {
            reason
        }
    }

    fn remove_checked(&self, expected: &[u8]) -> io::Result<()> {
        self.matches(self.name, expected)?;
        let backup = scratch_name();
        self.parent.move_to(self.name, &self.parent, &backup)?;
        if let Err(error) = self
            .matches(&backup, expected)
            .and_then(|_| self.parent.remove(&backup))
        {
            return Err(self.restore(&backup, error));
        }
        self.parent.sync();
        Ok(())
    }

    #[cfg(unix)]
    fn rewrite(&self, staged: &OsStr, before: &[u8], after: &[u8]) -> io::Result<()> {
        if let Err(error) = self.parent.exchange(staged, self.name) {
            let _ = self.parent.remove(staged);
            return Err(error);
        }
        if let Err(error) = self.matches(staged, before) {
            // The interchange captures exactly the entry displaced by our write.
            // If another writer has already replaced our published bytes, leave
            // their path alone and keep the displaced entry for manual recovery.
            if self.matches(self.name, after).is_ok()
                && self.parent.exchange(staged, self.name).is_ok()
                && self.matches(staged, after).is_ok()
            {
                let _ = self.parent.remove(staged);
                self.parent.sync();
                return Err(error);
            }
            self.parent.sync();
            return Err(io::Error::other(format!(
                "{error}; concurrent contents saved as {staged:?} beside the document"
            )));
        }
        self.discard_backup(staged);
        Ok(())
    }

    fn discard_backup(&self, name: &OsStr) {
        if let Err(error) = self.parent.remove(name) {
            // Publication already succeeded. Keep its undo entry even if the
            // redundant backup had to remain beside the document.
            eprintln!("MINT: could not remove folder edit backup {name:?}: {error}");
        }
        self.parent.sync();
    }

    #[cfg(windows)]
    fn rewrite(&self, staged: &OsStr, before: &[u8], _after: &[u8]) -> io::Result<()> {
        // Claim the directory entry before comparing it, then publish without
        // replacing any intervening save. The recovery name remains on disk if
        // another writer claims the original name in the meantime.
        let backup = scratch_name();
        let result = self
            .parent
            .move_to(self.name, &self.parent, &backup)
            .and_then(|_| {
                self.matches(&backup, before)
                    .and_then(|_| self.parent.move_to(staged, &self.parent, self.name))
                    .map_err(|error| self.restore(&backup, error))
            });
        if let Err(error) = result {
            let _ = self.parent.remove(staged);
            return Err(error);
        }
        self.discard_backup(&backup);
        Ok(())
    }
}

impl<'a> Edit<'a> {
    pub(crate) fn prepare(
        root: &Path,
        from: &'a Path,
        to: &'a Path,
        create: bool,
    ) -> io::Result<Self> {
        for path in [from, to] {
            let relative = path.to_str().ok_or_else(outside)?;
            if !crate::document_edit::valid_folder_document(
                &relative.replace(std::path::MAIN_SEPARATOR, "/"),
            ) {
                return Err(outside());
            }
        }
        let root = Directory::open(root)?;
        let in_place = from == to;
        let source = Entry::open(&root, from, in_place && create)?;
        let destination = if in_place {
            Entry {
                parent: source.parent.duplicate()?,
                name: source.name,
            }
        } else {
            Entry::open(&root, to, create)?
        };
        Ok(Self {
            source,
            destination,
            in_place,
        })
    }

    pub(crate) fn commit(self, before: Option<&[u8]>, after: Option<&[u8]>) -> io::Result<()> {
        let Self {
            source,
            destination,
            in_place,
        } = self;
        let permissions = before
            .map(|before| source.matches(source.name, before))
            .transpose()?;
        match (before, after) {
            (Some(before), None) if in_place => source.remove_checked(before),
            (Some(before), Some(after)) if in_place => {
                if before == after {
                    return Ok(());
                }
                let staged = destination.stage(after, permissions)?;
                destination.rewrite(&staged, before, after)
            }
            (Some(before), Some(after)) if before == after => {
                source
                    .parent
                    .move_to(source.name, &destination.parent, destination.name)?;
                if let Err(error) = destination.matches(destination.name, before) {
                    if let Err(restore) =
                        destination
                            .parent
                            .move_to(destination.name, &source.parent, source.name)
                    {
                        return Err(io::Error::other(format!("{error}; could not restore source ({restore}); document preserved at {:?}", destination.name)));
                    }
                    return Err(error);
                }
                source.parent.sync();
                destination.parent.sync();
                Ok(())
            }
            (before, Some(after)) => {
                let staged = destination.stage(after, permissions)?;
                if let Err(error) =
                    destination
                        .parent
                        .move_to(&staged, &destination.parent, destination.name)
                {
                    let _ = destination.parent.remove(&staged);
                    return Err(error);
                }
                destination.parent.sync();
                if let Some(before) = before {
                    if let Err(error) = source.remove_checked(before) {
                        if let Err(rollback) = destination.remove_checked(after) {
                            return Err(io::Error::other(format!(
                                "{error}; destination rollback failed: {rollback}"
                            )));
                        }
                        return Err(error);
                    }
                }
                Ok(())
            }
            _ => Err(outside()),
        }
    }
}

fn outside() -> io::Error {
    io::Error::other("document is outside the working folder or uses a link")
}

fn conflict() -> io::Error {
    io::Error::other("file changed since preview")
}

fn scratch_name() -> OsString {
    format!(".mint-recovery-{}", uuid::Uuid::new_v4()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rewrite_preserves_a_save_between_comparison_and_publication() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let file = root.join("chapter.md");
        fs::write(&file, b"original").unwrap();
        let directory = Directory::open(&root).unwrap();
        let entry = Entry::open(&directory, Path::new("chapter.md"), false).unwrap();
        let permissions = entry.matches(entry.name, b"original").unwrap();
        let staged = entry.stage(b"revision", Some(permissions)).unwrap();
        // A completed atomic save from another editor arrives during staging.
        let newer = folder.path().join("saving");
        fs::write(&newer, b"author's newer version").unwrap();
        fs::rename(newer, &file).unwrap();
        assert!(entry.rewrite(&staged, b"original", b"revision").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"author's newer version");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_validated_parent_with_a_link_does_not_redirect_writes() {
        use std::os::unix::fs::symlink;
        let folder = tempfile::tempdir().unwrap();
        let sandbox = folder.path().canonicalize().unwrap();
        let root = sandbox.join("root");
        let outside = sandbox.join("outside");
        fs::create_dir_all(root.join("chapter")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("chapter/note.md"), b"baseline").unwrap();
        fs::write(outside.join("note.md"), b"outside").unwrap();
        let relative = Path::new("chapter/note.md");

        let edit = Edit::prepare(&root, relative, relative, false).unwrap();
        fs::rename(root.join("chapter"), root.join("relocated")).unwrap();
        symlink(&outside, root.join("chapter")).unwrap();
        edit.commit(Some(b"baseline"), Some(b"revision")).unwrap();
        assert_eq!(
            fs::read(root.join("relocated/note.md")).unwrap(),
            b"revision"
        );
        assert_eq!(fs::read(outside.join("note.md")).unwrap(), b"outside");
        assert!(Edit::prepare(&root, relative, relative, false).is_err());
    }
}
