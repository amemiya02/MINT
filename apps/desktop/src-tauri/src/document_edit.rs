//! Checked edits used by the move preview, its rollback, and undo.
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use tempfile::{Builder, NamedTempFile, TempPath};

pub(crate) fn valid_folder_path(path: &str) -> bool {
    path.split('/').all(|part| {
        !part.is_empty()
            && !part.starts_with('.')
            && !part.ends_with(['.', ' '])
            && !part
                .chars()
                .any(|c| c.is_control() || "<>:\"\\|?*".contains(c))
    })
}

pub(crate) fn valid_folder_document(path: &str) -> bool {
    valid_folder_path(path)
        && Path::new(path)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown")
            })
}

/// Resolve against the granted root and reject symlink aliases in either path.
pub(crate) fn check_folder_path(root: &Path, path: &Path, resolved: &Path) -> io::Result<()> {
    let relative = path.strip_prefix(root).ok().and_then(Path::to_str);
    let canonical_root = fs::canonicalize(root)?;
    let outside =
        || io::Error::other("document is outside the working folder or uses a symbolic link");
    let relative = relative
        .filter(|relative| valid_folder_document(&relative.replace(std::path::MAIN_SEPARATOR, "/")))
        .ok_or_else(outside)?;
    if !resolved.starts_with(&canonical_root) {
        return Err(outside());
    }
    let mut entry = canonical_root;
    for component in Path::new(relative).components() {
        entry.push(component);
        match fs::symlink_metadata(&entry) {
            Ok(info) if info.is_symlink() => return Err(outside()),
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

/// Create destination folders for a reviewed operation and remove unused ones on failure.
pub(crate) fn with_destination(
    to: &Path,
    apply: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let mut missing = Vec::new();
    let mut directory = parent(to)?;
    while !directory.exists() {
        missing.push(directory);
        directory = parent(directory)?;
    }
    let mut created = Vec::new();
    let result = (|| {
        for directory in missing.into_iter().rev() {
            match fs::create_dir(directory) {
                Ok(()) => created.push(directory),
                Err(e)
                    if e.kind() == io::ErrorKind::AlreadyExists
                        && fs::symlink_metadata(directory).is_ok_and(|m| m.is_dir()) => {}
                Err(e) => return Err(e),
            }
        }
        apply()
    })();
    if result.is_err() {
        for directory in created.into_iter().rev() {
            let _ = fs::remove_dir(directory);
        }
    }
    result
}

pub(crate) fn create(to: &Path, text: &[u8]) -> io::Result<()> {
    let directory = parent(to)?;
    let mut temp = NamedTempFile::new_in(directory)?;
    temp.write_all(text)?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(to).map_err(|e| e.error)?;
    crate::fs::sync_dir(directory);
    Ok(())
}

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
pub(crate) fn remove_checked(path: &Path, expected: &[u8]) -> io::Result<()> {
    check(path, expected)?;
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

/// Windows may briefly refuse replacement while an indexer or another reader
/// holds the destination. Recheck the preview before each atomic publish.
fn publish_rewrite(mut temp: NamedTempFile, to: &Path, before: &[u8]) -> io::Result<()> {
    let mut retries = 0;
    loop {
        check(to, before)?;
        match temp.persist(to) {
            Ok(_) => return Ok(()),
            Err(e)
                if cfg!(windows)
                    && retries < 20
                    && matches!(e.error.raw_os_error(), Some(5 | 32 | 33)) =>
            {
                temp = e.file;
                retries += 1;
                std::thread::sleep(std::time::Duration::from_millis(retries * 3));
            }
            Err(e) => return Err(e.error),
        }
    }
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
    if from == to {
        publish_rewrite(temp, to, before)?;
        crate::fs::sync_dir(destination);
        return Ok(());
    }
    // Publish the rewritten document before removing the old name. Even a
    // crash during a cross-directory move leaves a complete, visible copy.
    check(from, before)?;
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
