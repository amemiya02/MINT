//! Folder primitives behind the platform interface: listing, creating,
//! renaming and trashing entries of a folder, and watching it for changes.
//! Nothing here writes private data into the folder.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;

/// One child of a directory, as shown in the file tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub kind: EntryKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
}

/// List the direct children of `dir`, in no particular order. Symbolic links
/// are reported as what they point to; a broken link is reported as a file.
pub fn list_dir(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let is_dir = fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        entries.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            path,
            kind: if is_dir {
                EntryKind::Directory
            } else {
                EntryKind::File
            },
        });
    }
    Ok(entries)
}

/// Create an empty file. Fails if anything already exists at `path`.
pub fn create_file(path: &Path) -> io::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
}

/// Create a directory. Fails if anything already exists at `path` or the parent is missing.
pub fn create_dir(path: &Path) -> io::Result<()> {
    fs::create_dir(path)
}

/// Rename a file or directory. Never replaces an existing entry, except that a
/// case-only rename (`a.md` → `A.md`) works on case-insensitive file systems.
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    if fs::symlink_metadata(to).is_ok() && !same_entry(from, to) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", to.display()),
        ));
    }
    fs::rename(from, to)
}

fn same_entry(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Move a file or directory to the system trash. Never falls back to a permanent delete.
pub fn move_to_trash(path: &Path) -> io::Result<()> {
    trash::delete(path).map_err(io::Error::other)
}

/// Whether a changed path is MINT's own transient file (see `fs::write_atomic`).
fn is_own_temp_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(".mint-") && n.ends_with(".tmp"))
}

/// Watches a folder recursively. Bursts of changes are debounced and reported
/// as one list of changed paths. Dropping the watcher stops it.
pub struct FolderWatcher {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

impl FolderWatcher {
    pub fn new(
        dir: &Path,
        on_change: impl Fn(Vec<PathBuf>) + Send + 'static,
    ) -> notify_debouncer_full::notify::Result<Self> {
        let (tx, rx) = mpsc::channel::<DebounceEventResult>();
        let mut debouncer = new_debouncer(Duration::from_millis(200), None, tx)?;
        debouncer.watch(dir, RecursiveMode::Recursive)?;
        std::thread::spawn(move || {
            // Ends when the debouncer (and with it the sender) is dropped.
            for result in rx {
                let Ok(events) = result else { continue };
                let mut paths: Vec<PathBuf> = events
                    .into_iter()
                    .flat_map(|e| e.event.paths)
                    .filter(|p| !is_own_temp_file(p))
                    .collect();
                paths.sort();
                paths.dedup();
                if !paths.is_empty() {
                    on_change(paths);
                }
            }
        });
        Ok(Self {
            _debouncer: debouncer,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted_names(entries: Vec<Entry>) -> Vec<(String, EntryKind)> {
        let mut names: Vec<_> = entries.into_iter().map(|e| (e.name, e.kind)).collect();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        names
    }

    #[test]
    fn list_dir_reports_files_and_directories() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes").join("deep.md"), "").unwrap();

        let entries = list_dir(dir.path()).unwrap();

        assert_eq!(
            sorted_names(entries.clone()),
            vec![
                ("a.md".to_string(), EntryKind::File),
                ("notes".to_string(), EntryKind::Directory),
            ]
        );
        let file = entries.iter().find(|e| e.name == "a.md").unwrap();
        assert_eq!(file.path, dir.path().join("a.md"));
    }

    #[test]
    fn list_dir_fails_for_a_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_dir(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn create_file_creates_an_empty_file_but_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.md");

        create_file(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"");

        fs::write(&path, "keep").unwrap();
        let error = create_file(&path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&path).unwrap(), b"keep");
    }

    #[test]
    fn create_dir_creates_a_directory_but_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("drafts");

        create_dir(&path).unwrap();
        assert!(path.is_dir());
        assert!(create_dir(&path).is_err());
    }

    #[test]
    fn rename_moves_files_and_directories() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("old.md"), "body").unwrap();
        fs::create_dir(dir.path().join("folder")).unwrap();

        rename(&dir.path().join("old.md"), &dir.path().join("new.md")).unwrap();
        rename(&dir.path().join("folder"), &dir.path().join("renamed")).unwrap();

        assert_eq!(fs::read(dir.path().join("new.md")).unwrap(), b"body");
        assert!(!dir.path().join("old.md").exists());
        assert!(dir.path().join("renamed").is_dir());
    }

    #[test]
    fn rename_refuses_to_replace_an_existing_entry() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "a").unwrap();
        fs::write(dir.path().join("b.md"), "b").unwrap();

        let error = rename(&dir.path().join("a.md"), &dir.path().join("b.md")).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(dir.path().join("a.md")).unwrap(), b"a");
        assert_eq!(fs::read(dir.path().join("b.md")).unwrap(), b"b");
    }

    #[test]
    fn rename_allows_changing_only_the_case() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("note.md"), "body").unwrap();

        rename(&dir.path().join("note.md"), &dir.path().join("Note.md")).unwrap();

        let names: Vec<_> = sorted_names(list_dir(dir.path()).unwrap())
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(names, vec!["Note.md"]);
    }

    /// Moves a real file into the user's trash, so it is opt-in:
    /// `cargo test -- --ignored move_to_trash`.
    #[test]
    #[ignore]
    fn move_to_trash_removes_the_entry_from_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mint-trash-test.md");
        fs::write(&path, "bye").unwrap();

        move_to_trash(&path).unwrap();

        assert!(!path.exists());
    }

    #[test]
    fn move_to_trash_fails_for_a_missing_entry() {
        let dir = tempfile::tempdir().unwrap();
        assert!(move_to_trash(&dir.path().join("missing.md")).is_err());
    }

    fn watch(dir: &Path) -> (FolderWatcher, mpsc::Receiver<Vec<PathBuf>>) {
        let (tx, rx) = mpsc::channel();
        let watcher = FolderWatcher::new(dir, move |paths| {
            let _ = tx.send(paths);
        })
        .unwrap();
        // Give the platform watcher a moment to start (FSEvents has latency).
        std::thread::sleep(Duration::from_millis(300));
        (watcher, rx)
    }

    fn changed_names(rx: &mpsc::Receiver<Vec<PathBuf>>) -> Vec<String> {
        let mut names = Vec::new();
        while let Ok(paths) = rx.recv_timeout(Duration::from_secs(3)) {
            names.extend(
                paths
                    .iter()
                    .filter_map(|p| p.file_name())
                    .map(|n| n.to_string_lossy().into_owned()),
            );
        }
        names
    }

    #[test]
    fn watcher_reports_external_changes_in_nested_directories() {
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(dir.join("nested")).unwrap();
        let (_watcher, rx) = watch(&dir);

        fs::write(dir.join("nested").join("added.md"), "new").unwrap();

        assert!(changed_names(&rx).contains(&"added.md".to_string()));
    }

    #[test]
    fn watcher_hides_mints_own_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        let (_watcher, rx) = watch(&dir);

        crate::fs::write_atomic(&dir.join("doc.md"), b"saved").unwrap();

        let names = changed_names(&rx);
        assert!(names.contains(&"doc.md".to_string()));
        assert!(names.iter().all(|n| !n.starts_with(".mint-")), "{names:?}");
    }
}
