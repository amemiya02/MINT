//! The theme folder: user themes are `.css` files in `themes` inside the app
//! data directory. The shell lists, reads and watches it with the ordinary
//! folder commands; the backend only says where it is and makes sure it exists,
//! so a user can always open it and drop a theme in.

use std::io;
use std::path::{Path, PathBuf};

pub const DIR_NAME: &str = "themes";

/// The theme folder inside `app_data_dir`, created (with its parents) if missing.
pub fn ensure_dir(app_data_dir: &Path) -> io::Result<PathBuf> {
    let dir = app_data_dir.join(DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_theme_folder_and_its_parents() {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path().join("io.github.amemiya02.mint");

        let dir = ensure_dir(&app_data).unwrap();

        assert_eq!(dir, app_data.join("themes"));
        assert!(dir.is_dir());
    }

    #[test]
    fn keeps_the_themes_already_there() {
        let root = tempfile::tempdir().unwrap();
        let dir = ensure_dir(root.path()).unwrap();
        std::fs::write(dir.join("paper.css"), ":root {}").unwrap();

        let again = ensure_dir(root.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(again.join("paper.css")).unwrap(),
            ":root {}"
        );
    }
}
