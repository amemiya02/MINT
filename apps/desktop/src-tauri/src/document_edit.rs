//! Checked edits used by the move preview, its rollback, and undo.
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use tempfile::{Builder, NamedTempFile, TempPath};

fn parent(path: &Path) -> io::Result<&Path> {
    path.parent()
        .ok_or_else(|| io::Error::other("missing parent"))
}

fn check(path: &Path, expected: &[u8]) -> io::Result<()> {
    if !fs::symlink_metadata(path)?.is_file() || fs::read(path)? != expected {
        return Err(io::Error::other("file changed since preview"));
    }
    Ok(())
}

/// Move exactly one existing entry without overwriting a concurrently created one.
fn move_entry(from: &Path, to: &Path) -> io::Result<()> {
    let mut path = TempPath::try_from_path(from)?;
    path.disable_cleanup(true);
    path.persist_noclobber(to).map_err(|e| e.error)
}

/// Claim the entry being removed, so a newer document is preserved even
/// if another editor replaced it after our last comparison.
fn remove_checked(path: &Path, expected: &[u8]) -> io::Result<()> {
    let backup = Builder::new()
        .prefix(".mint-move-")
        .tempdir_in(parent(path)?)?;
    let original = backup.path().join("original");
    fs::rename(path, &original)?;
    if let Err(error) = check(&original, expected) {
        if let Err(restore) = move_entry(&original, path) {
            let saved = backup.keep().join("original");
            return Err(io::Error::other(format!(
                "{error}; could not restore {} ({restore}); original preserved at {}",
                path.display(),
                saved.display()
            )));
        }
        return Err(error);
    }
    Ok(())
}

pub fn apply(from: &Path, to: &Path, before: &[u8], after: &[u8]) -> io::Result<()> {
    check(from, before)?;
    if from != to
        && fs::symlink_metadata(to).is_ok_and(|m| m.is_file())
        && crate::fs::same_entry(from, to)
    {
        // On a case-insensitive volume the new spelling already names the source.
        fs::rename(from, to)?;
        if let Err(error) = apply(to, to, before, after) {
            fs::rename(to, from).map_err(|restore| {
                io::Error::other(format!(
                    "{error}; could not restore {}: {restore}",
                    from.display()
                ))
            })?;
            return Err(error);
        }
        return Ok(());
    }
    if before == after {
        if from != to {
            move_entry(from, to)?;
            if let Err(error) = check(to, before) {
                move_entry(to, from).map_err(|restore| {
                    io::Error::other(format!(
                        "{error}; could not restore {} ({restore}); document preserved at {}",
                        from.display(),
                        to.display()
                    ))
                })?;
                return Err(error);
            }
        }
        return Ok(());
    }

    let destination = parent(to)?;
    let mut temp = NamedTempFile::new_in(destination)?;
    temp.write_all(after)?;
    temp.as_file()
        .set_permissions(fs::metadata(from)?.permissions())?;
    temp.as_file().sync_all()?;
    check(from, before)?;
    if from == to {
        temp.persist(to).map_err(|e| e.error)?;
        crate::fs::sync_dir(destination);
        return Ok(());
    }
    // Publish the rewritten document before removing the old name. Even a
    // crash during a cross-directory move leaves a complete, visible copy.
    temp.persist_noclobber(to).map_err(|e| e.error)?;
    crate::fs::sync_dir(destination);
    if let Err(error) = remove_checked(from, before) {
        remove_checked(to, after).map_err(|rollback| {
            io::Error::other(format!(
                "{error}; could not revert {}: {rollback}",
                to.display()
            ))
        })?;
        return Err(error);
    }
    crate::fs::sync_dir(parent(from)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_place_reference_is_always_readable_during_rewrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reference.md");
        fs::write(&path, b"old").unwrap();
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| {
                for _ in 0..16 {
                    apply(&path, &path, b"old", b"new").unwrap();
                    apply(&path, &path, b"new", b"old").unwrap();
                }
            });
            while !writer.is_finished() {
                let bytes = fs::read(&path).unwrap();
                assert!(bytes == b"old" || bytes == b"new");
            }
        });
    }

    #[test]
    fn case_only_moves_keep_the_requested_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("note.md");
        let new = dir.path().join("Note.md");
        fs::write(&old, b"link").unwrap();
        apply(&old, &new, b"link", b"updated").unwrap();
        assert_eq!(
            fs::read_dir(dir.path())
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .file_name(),
            "Note.md"
        );
        apply(&new, &old, b"updated", b"updated").unwrap();
        assert_eq!(
            fs::read_dir(dir.path())
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .file_name(),
            "note.md"
        );
    }

    #[test]
    fn rewritten_move_and_undo_keep_source_permissions_and_never_clobber_a_destination() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        fs::write(&old, b"link").unwrap();
        fs::write(&new, b"external").unwrap();
        assert!(apply(&old, &new, b"link", b"updated").is_err());
        assert_eq!(fs::read(&old).unwrap(), b"link");
        assert_eq!(fs::read(&new).unwrap(), b"external");
        fs::remove_file(&new).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&old, fs::Permissions::from_mode(0o640)).unwrap();
        }
        apply(&old, &new, b"link", b"updated").unwrap();
        assert_eq!(fs::read(&new).unwrap(), b"updated");
        assert!(!old.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&new).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        apply(&new, &old, b"updated", b"link").unwrap();
        assert_eq!(fs::read(&old).unwrap(), b"link");
        assert!(!new.exists());
    }

    #[test]
    fn move_and_undo_preserve_real_file_bytes_and_refuse_stale_content() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("old.md");
        let target = dir.path().join("new.md");
        let reference = dir.path().join("ref.md");
        let old = "\u{feff}[see](old.md#one)\r\n\nline\r".as_bytes();
        let new = "\u{feff}[see](new.md#one)\r\n\nline\r".as_bytes();
        fs::write(&source, b"body\r\n").unwrap();
        fs::write(&reference, old).unwrap();
        apply(&source, &target, b"body\r\n", b"body\r\n").unwrap();
        apply(&reference, &reference, old, new).unwrap();
        assert_eq!(fs::read(&reference).unwrap(), new);
        assert!(!source.exists());
        fs::write(&source, b"external").unwrap();
        assert!(apply(&target, &source, b"body\r\n", b"body\r\n").is_err());
        assert_eq!(fs::read(&source).unwrap(), b"external");
        assert_eq!(fs::read(&target).unwrap(), b"body\r\n");
        fs::remove_file(&source).unwrap();
        apply(&target, &source, b"body\r\n", b"body\r\n").unwrap();
        apply(&reference, &reference, new, old).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"body\r\n");
        assert_eq!(fs::read(&reference).unwrap(), old);
        fs::write(&reference, b"external").unwrap();
        assert!(apply(&reference, &reference, old, new).is_err());
        assert_eq!(fs::read(&reference).unwrap(), b"external");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}
