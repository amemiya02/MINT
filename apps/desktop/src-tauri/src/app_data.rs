//! Small named files in MINT's app data directory (recently opened list, and
//! later recovery data). This is where MINT keeps its own state, never in a
//! folder the user opened.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Resolve a name inside the app data directory. Only plain file names are
/// accepted, so a caller cannot reach outside it.
fn resolve(dir: &Path, name: &str) -> io::Result<PathBuf> {
    let valid = !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !valid {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid app data name: {name:?}"),
        ));
    }
    Ok(dir.join(name))
}

/// Read a named file, or `None` if it does not exist yet.
pub fn read(dir: &Path, name: &str) -> io::Result<Option<String>> {
    match crate::fs::read_text(&resolve(dir, name)?) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Write a named file atomically, creating the app data directory if needed.
pub fn write(dir: &Path, name: &str, text: &str) -> io::Result<()> {
    let path = resolve(dir, name)?;
    fs::create_dir_all(dir)?;
    crate::fs::write_atomic(&path, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_a_missing_file_gives_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path(), "recent.json").unwrap(), None);
    }

    #[test]
    fn write_then_read_round_trips_and_creates_the_directory() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("io.github.amemiya02.mint");

        write(&dir, "recent.json", "{\"documents\":[]}").unwrap();

        assert_eq!(
            read(&dir, "recent.json").unwrap().as_deref(),
            Some("{\"documents\":[]}")
        );
    }

    #[test]
    fn names_that_could_escape_the_directory_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["../evil.json", "a/b.json", "..", ".hidden", "", "c:\\x"] {
            assert!(write(dir.path(), name, "x").is_err(), "{name}");
            assert!(read(dir.path(), name).is_err(), "{name}");
        }
    }
}
