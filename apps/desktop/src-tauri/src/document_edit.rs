//! Checked edits used by the move preview, its rollback, and undo.
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use tempfile::{Builder, NamedTempFile, TempPath};

pub fn apply(from: &Path, to: &Path, before: &[u8], after: &[u8]) -> io::Result<()> {
    let metadata = fs::symlink_metadata(from)?;
    if !metadata.is_file() {
        return Err(io::Error::other("expected a regular document"));
    }
    let check = |path: &Path| {
        if fs::read(path)? != before {
            Err(io::Error::other("file changed since preview"))
        } else {
            Ok(())
        }
    };
    check(from)?;
    let parent = |path: &Path| {
        path.parent()
            .map(Path::to_owned)
            .ok_or_else(|| io::Error::other("missing parent"))
    };
    let prepared = if before == after {
        None
    } else {
        let mut temp = NamedTempFile::new_in(parent(to)?)?;
        temp.write_all(after)?;
        temp.as_file().set_permissions(metadata.permissions())?;
        temp.as_file().sync_all()?;
        Some(temp)
    };

    // Claim exactly the entry being replaced. Verify it again after the rename:
    // another editor may have replaced it while the updated file was being staged.
    let backup = Builder::new()
        .prefix(".mint-move-")
        .tempdir_in(parent(from)?)?;
    let original = backup.path().join("original");
    fs::rename(from, &original)?;
    let install_original = |dest: &Path| {
        let mut path = TempPath::try_from_path(&original)?;
        // The backup directory owns cleanup, including on installation failure.
        path.disable_cleanup(true);
        path.persist_noclobber(dest).map_err(|e| e.error)
    };
    let install = || {
        if !fs::symlink_metadata(&original)?.is_file() {
            return Err(io::Error::other("document replaced since preview"));
        }
        check(&original)?;
        // A new entry appearing at the destination must win, even during undo.
        match prepared {
            Some(temp) => temp.persist_noclobber(to).map(|_| ()).map_err(|e| e.error),
            None => install_original(to),
        }
    };
    if let Err(error) = install() {
        if let Err(restore) = install_original(from) {
            let saved = backup.keep().join("original");
            return Err(io::Error::other(format!(
                "{error}; could not restore {} ({restore}); original preserved at {}",
                from.display(),
                saved.display()
            )));
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
