//! User-granted roots: the only places the file commands may touch.
//!
//! A path is granted when the user hands it to MINT: it comes back from an
//! open or save dialog, is a folder the user opened, or was opened through a
//! file association or the command line. A document grants its whole
//! directory (its asset folder, sibling documents its links point to); a
//! folder grants itself. MINT's own files (settings.json, the theme folder)
//! are granted at startup.
//!
//! Grants from the user are remembered in the app data directory, so the
//! recently opened list and the recovery area keep working after a restart.
//! That file lives outside every granted root, so the page cannot extend its
//! own grants by writing it.
//!
//! Every path is compared after resolving symbolic links and `..`, so neither
//! a link inside a granted folder nor a `../` can reach outside it.

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// How many remembered grants are kept; the oldest are forgotten first.
const MAX_REMEMBERED: usize = 500;

/// One granted root, by its resolved (canonical) path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "path", rename_all = "camelCase")]
pub enum Grant {
    /// A directory and everything under it.
    Directory(PathBuf),
    /// Exactly one file.
    File(PathBuf),
}

impl Grant {
    fn covers(&self, path: &Path) -> bool {
        match self {
            Grant::Directory(root) => path.starts_with(root),
            Grant::File(file) => path == file,
        }
    }
}

/// The granted roots of this run.
pub struct Grants {
    /// Remembered across runs (the user's grants).
    remembered: Mutex<Vec<Grant>>,
    /// For this run only (MINT's own files).
    session: Mutex<Vec<Grant>>,
    store: Option<PathBuf>,
}

impl Grants {
    /// Grants kept in memory only (tests).
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            remembered: Mutex::new(Vec::new()),
            session: Mutex::new(Vec::new()),
            store: None,
        }
    }

    /// Load the grants remembered in `store` (a JSON file); a missing or broken
    /// file starts empty, and the reason is logged.
    pub fn load(store: PathBuf) -> Self {
        let remembered = match std::fs::read(&store) {
            Ok(bytes) => serde_json::from_slice::<Vec<Grant>>(&bytes)
                .inspect_err(|e| eprintln!("MINT: ignoring the remembered grants: {e}"))
                .unwrap_or_default(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                eprintln!("MINT: cannot read the remembered grants: {e}");
                Vec::new()
            }
        };
        Self {
            remembered: Mutex::new(remembered),
            session: Mutex::new(Vec::new()),
            store: Some(store),
        }
    }

    /// Every granted root, remembered ones first.
    pub fn all(&self) -> Vec<Grant> {
        let mut all = lock(&self.remembered).clone();
        all.extend(lock(&self.session).iter().cloned());
        all
    }

    /// The user opened or saved the document at `path`: grant its directory,
    /// and the file itself when it is a link to somewhere else. Returns the
    /// new grants.
    pub fn grant_document(&self, path: &Path) -> io::Result<Vec<Grant>> {
        let resolved = resolve(path)?;
        let mut granted = Vec::new();
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            granted.push(Grant::Directory(resolve(dir)?));
        }
        if !resolved
            .parent()
            .is_some_and(|dir| granted.iter().any(|g| g.covers(dir)))
        {
            granted.push(Grant::File(resolved));
        }
        self.remember(&granted)?;
        Ok(granted)
    }

    /// The user opened the folder at `path`: grant it and everything under it.
    pub fn grant_folder(&self, path: &Path) -> io::Result<Grant> {
        let grant = Grant::Directory(resolve(path)?);
        self.remember(std::slice::from_ref(&grant))?;
        Ok(grant)
    }

    /// Grant a path of MINT's own for this run only (not remembered).
    pub fn grant_own(&self, path: &Path, directory: bool) -> io::Result<Grant> {
        let resolved = resolve(path)?;
        let grant = if directory {
            Grant::Directory(resolved)
        } else {
            Grant::File(resolved)
        };
        let mut session = lock(&self.session);
        if !session.contains(&grant) {
            session.push(grant.clone());
        }
        Ok(grant)
    }

    /// `path`, resolved, if it lies within a granted root; an error naming it otherwise.
    pub fn check(&self, path: &Path) -> io::Result<PathBuf> {
        let denied = || {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "{} is outside the documents and folders you opened",
                    path.display()
                ),
            )
        };
        let resolved = resolve(path).map_err(|_| denied())?;
        if self.all().iter().any(|g| g.covers(&resolved)) {
            Ok(resolved)
        } else {
            Err(denied())
        }
    }

    fn remember(&self, grants: &[Grant]) -> io::Result<()> {
        let mut remembered = lock(&self.remembered);
        for grant in grants {
            remembered.retain(|g| g != grant);
            remembered.push(grant.clone());
        }
        let excess = remembered.len().saturating_sub(MAX_REMEMBERED);
        remembered.drain(..excess);
        if let Some(store) = &self.store {
            if let Some(dir) = store.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let text = serde_json::to_vec_pretty(&*remembered).map_err(io::Error::other)?;
            crate::fs::write_atomic(store, &text)?;
        }
        Ok(())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Resolve an absolute path, which need not exist yet: its longest existing
/// ancestor is canonicalised (resolving links and `..`), and the rest is
/// appended. A `..` in the part that does not exist is rejected, since it
/// cannot be resolved safely.
pub fn resolve(path: &Path) -> io::Result<PathBuf> {
    let invalid = |why: &str| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{}: {why}", path.display()),
        )
    };
    if !path.is_absolute() {
        return Err(invalid("not an absolute path"));
    }
    let mut existing = path;
    let mut rest = Vec::new();
    let base = loop {
        match std::fs::canonicalize(existing) {
            Ok(base) => break base,
            Err(_) => {
                let name = existing
                    .file_name()
                    .ok_or_else(|| invalid("unresolvable"))?;
                rest.push(name.to_os_string());
                existing = existing.parent().ok_or_else(|| invalid("unresolvable"))?;
            }
        }
    };
    // `file_name` is `None` for a trailing `..`, so check the missing part explicitly.
    let missing = path.strip_prefix(existing).unwrap_or(Path::new(""));
    if missing
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(invalid("`..` in a path that does not exist"));
    }
    let mut resolved = base;
    for name in rest.into_iter().rev() {
        if name != "." {
            resolved.push(name);
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let notes = root.join("notes");
        let secret = root.join("secret");
        fs::create_dir_all(notes.join("assets")).unwrap();
        fs::create_dir_all(&secret).unwrap();
        fs::write(notes.join("a.md"), "# A").unwrap();
        fs::write(secret.join("key.txt"), "s3cr3t").unwrap();
        (dir, notes, secret)
    }

    #[test]
    fn nothing_is_granted_at_first() {
        let (_dir, notes, _) = setup();
        let grants = Grants::in_memory();

        assert!(grants.check(&notes.join("a.md")).is_err());
    }

    #[test]
    fn an_opened_document_grants_its_directory() {
        let (_dir, notes, secret) = setup();
        let grants = Grants::in_memory();

        grants.grant_document(&notes.join("a.md")).unwrap();

        assert!(grants.check(&notes.join("a.md")).is_ok());
        assert!(
            grants.check(&notes.join("b.md")).is_ok(),
            "a sibling, not created yet"
        );
        assert!(grants.check(&notes.join("assets").join("x.png")).is_ok());
        let denied = grants.check(&secret.join("key.txt")).unwrap_err();
        assert_eq!(denied.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn an_opened_folder_grants_everything_under_it() {
        let (_dir, notes, secret) = setup();
        let grants = Grants::in_memory();

        grants.grant_folder(&notes).unwrap();

        assert!(grants.check(&notes).is_ok());
        assert!(grants
            .check(&notes.join("assets").join("new").join("y.png"))
            .is_ok());
        assert!(grants.check(&secret).is_err());
        assert!(grants.check(notes.parent().unwrap()).is_err());
    }

    #[test]
    fn dot_dot_cannot_escape_a_granted_root() {
        let (_dir, notes, _secret) = setup();
        let grants = Grants::in_memory();
        grants.grant_folder(&notes).unwrap();

        for path in [
            notes.join("..").join("secret").join("key.txt"),
            notes.join("assets").join("..").join("..").join("secret"),
            notes
                .join("missing")
                .join("..")
                .join("..")
                .join("secret")
                .join("new.md"),
        ] {
            assert!(grants.check(&path).is_err(), "{}", path.display());
        }
        // Resolving `..` that stays inside is fine.
        assert!(grants
            .check(&notes.join("assets").join("..").join("a.md"))
            .is_ok());
    }

    #[test]
    fn a_folder_with_a_shared_prefix_is_not_inside() {
        let (_dir, notes, _) = setup();
        let sibling = notes.parent().unwrap().join("notes-private");
        fs::create_dir(&sibling).unwrap();
        let grants = Grants::in_memory();
        grants.grant_folder(&notes).unwrap();

        assert!(grants.check(&sibling.join("x.md")).is_err());
    }

    #[test]
    fn relative_paths_are_rejected() {
        let grants = Grants::in_memory();
        grants
            .grant_folder(&std::env::current_dir().unwrap())
            .unwrap();

        assert!(grants.check(Path::new("a.md")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_inside_a_granted_folder_cannot_reach_outside_it() {
        let (_dir, notes, secret) = setup();
        std::os::unix::fs::symlink(&secret, notes.join("escape")).unwrap();
        std::os::unix::fs::symlink(secret.join("key.txt"), notes.join("key.md")).unwrap();
        let grants = Grants::in_memory();
        grants.grant_folder(&notes).unwrap();

        assert!(grants.check(&notes.join("escape").join("key.txt")).is_err());
        assert!(grants.check(&notes.join("key.md")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_document_the_user_opened_is_granted_through_its_link() {
        let (_dir, notes, secret) = setup();
        let link = notes.join("key.md");
        std::os::unix::fs::symlink(secret.join("key.txt"), &link).unwrap();
        let grants = Grants::in_memory();

        grants.grant_document(&link).unwrap();

        assert!(grants.check(&link).is_ok());
        assert!(grants.check(&secret.join("other.txt")).is_err());
    }

    #[test]
    fn own_grants_are_not_remembered() {
        let (dir, notes, _) = setup();
        let store = dir.path().join("data").join("access").join("grants.json");
        let settings = notes.join("settings.json");
        {
            let grants = Grants::load(store.clone());
            grants.grant_own(&settings, false).unwrap();
            grants.grant_document(&notes.join("a.md")).unwrap();
            assert!(grants.check(&settings).is_ok());
        }

        let grants = Grants::load(store);

        assert!(
            grants.check(&notes.join("a.md")).is_ok(),
            "remembered across runs"
        );
        assert_eq!(grants.all(), vec![Grant::Directory(notes)]);
    }

    #[test]
    fn a_settings_file_grant_covers_only_that_file() {
        let (_dir, notes, _) = setup();
        let grants = Grants::in_memory();

        grants
            .grant_own(&notes.join("settings.json"), false)
            .unwrap();

        assert!(grants.check(&notes.join("settings.json")).is_ok());
        assert!(grants.check(&notes.join("a.md")).is_err());
    }

    #[test]
    fn a_broken_store_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("grants.json");
        fs::write(&store, "not json").unwrap();

        assert!(Grants::load(store).all().is_empty());
    }
}
