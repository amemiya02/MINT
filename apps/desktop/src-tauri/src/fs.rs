//! File system primitives behind the platform interface.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Read a file as UTF-8 text. A byte order mark is kept as a leading U+FEFF and
/// line endings are untouched, so the front end sees the exact file content.
pub fn read_text(path: &Path) -> io::Result<String> {
    let bytes = fs::read(path)?;
    String::from_utf8(bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the file is not valid UTF-8 text",
        )
    })
}

/// Replace the contents of `path` atomically: the bytes are written to a
/// temporary file in the same directory, flushed to disk, then renamed over
/// the target. Readers see either the old or the new content, never a mix,
/// and a crash mid-write leaves the original file intact.
///
/// An existing file's permissions are carried over, and a symbolic link is
/// written through (its target is replaced, the link is kept).
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let target = resolve_link(path)?;
    let dir = match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };

    let mut temp = tempfile::Builder::new()
        .prefix(".mint-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    temp.write_all(contents)?;
    if let Ok(metadata) = fs::metadata(&target) {
        temp.as_file().set_permissions(metadata.permissions())?;
    }
    temp.as_file().sync_all()?;
    temp.persist(&target).map_err(|e| e.error)?;
    sync_dir(dir);
    Ok(())
}

fn resolve_link(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(path),
        _ => Ok(path.to_path_buf()),
    }
}

/// Make the rename itself durable. Best effort: not every platform allows it.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn write_atomic_creates_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.md");

        write_atomic(&path, b"# New\n").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"# New\n");
    }

    #[test]
    fn write_atomic_replaces_existing_content_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "a much longer original body\r\n").unwrap();

        write_atomic(&path, "\u{feff}short\r\n".as_bytes()).unwrap();

        assert_eq!(fs::read(&path).unwrap(), "\u{feff}short\r\n".as_bytes());
    }

    #[test]
    fn write_atomic_leaves_no_temporary_files_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "old").unwrap();

        write_atomic(&path, b"new").unwrap();

        assert_eq!(entries(dir.path()), vec!["doc.md"]);
    }

    #[test]
    fn write_atomic_fails_cleanly_when_the_directory_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("doc.md");

        assert!(write_atomic(&path, b"text").is_err());
        assert!(entries(dir.path()).is_empty());
    }

    #[test]
    fn write_atomic_keeps_the_original_when_the_rename_fails() {
        let dir = tempfile::tempdir().unwrap();
        // A non-empty directory cannot be replaced by a file.
        let path = dir.path().join("doc.md");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("child"), "keep").unwrap();

        assert!(write_atomic(&path, b"text").is_err());
        assert_eq!(fs::read(path.join("child")).unwrap(), b"keep");
        assert_eq!(entries(dir.path()), vec!["doc.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        write_atomic(&path, b"new").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_writes_through_symbolic_links() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.md");
        let link = dir.path().join("link.md");
        fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write_atomic(&link, b"new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"new");
    }

    #[test]
    fn read_text_keeps_bom_and_line_endings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "\u{feff}# Title\r\nbody\r\n").unwrap();

        assert_eq!(read_text(&path).unwrap(), "\u{feff}# Title\r\nbody\r\n");
    }

    #[test]
    fn read_text_rejects_invalid_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("latin1.md");
        fs::write(&path, [0x63, 0x61, 0x66, 0xe9]).unwrap();

        let error = read_text(&path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
