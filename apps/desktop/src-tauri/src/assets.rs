//! Assets (pasted or dropped images) saved into a document's asset folder.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Save `data` as a new file in `dir` (created with its parents if missing),
/// named `file_name` or, if that is taken, `stem-1.ext`, `stem-2.ext`...
/// Nothing is ever overwritten: the name is claimed with `create_new`, so two
/// saves racing for the same name both succeed under different names.
/// Returns the path of the new file.
pub fn save(dir: &Path, file_name: &str, data: &[u8]) -> io::Result<PathBuf> {
    if file_name.is_empty() || file_name.contains(['/', '\\']) || file_name == ".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the asset name must be a single file name",
        ));
    }
    fs::create_dir_all(dir)?;
    let (stem, extension) = match file_name.rfind('.') {
        Some(dot) if dot > 0 => file_name.split_at(dot),
        _ => (file_name, ""),
    };
    for n in 0u32.. {
        let name = if n == 0 {
            file_name.to_owned()
        } else {
            format!("{stem}-{n}{extension}")
        };
        let path = dir.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                let written = file.write_all(data).and_then(|()| file.sync_all());
                if let Err(e) = written {
                    let _ = fs::remove_file(&path);
                    return Err(e);
                }
                return Ok(path);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!("ran out of asset names")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_into_a_new_asset_folder() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("notes").join("assets");

        let path = save(&dir, "image.png", b"\x89PNG").unwrap();

        assert_eq!(path, dir.join("image.png"));
        assert_eq!(fs::read(&path).unwrap(), b"\x89PNG");
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.png"), "old").unwrap();
        fs::write(dir.path().join("a-1.png"), "old").unwrap();

        let path = save(dir.path(), "a.png", b"new").unwrap();

        assert_eq!(path, dir.path().join("a-2.png"));
        assert_eq!(fs::read(dir.path().join("a.png")).unwrap(), b"old");
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn numbers_names_without_an_extension() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("shot"), "old").unwrap();

        assert_eq!(
            save(dir.path(), "shot", b"x").unwrap(),
            dir.path().join("shot-1")
        );
    }

    #[test]
    fn rejects_names_that_are_paths() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save(dir.path(), "../evil.png", b"x").is_err());
        assert!(save(dir.path(), "", b"x").is_err());
    }
}
