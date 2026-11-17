//! Folder primitives behind the platform interface: listing, creating,
//! renaming and trashing entries of a folder, and watching it for changes.
//! Nothing here writes private data into the folder.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;

use crate::walk;

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

/// Watches a folder recursively, or a single document. Bursts of changes are
/// debounced and reported together. Dropping the watcher stops it.
pub struct FolderWatcher {
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

impl FolderWatcher {
    /// Watch `dir` recursively; `on_change` gets the changed paths of each
    /// batch, always under `dir` as given. Changes inside `.git` and to entries
    /// the folder's ignore files exclude (see [`walk::IgnoredPaths`]) are not
    /// reported: build output and git's own churn would otherwise flood it.
    pub fn new(
        dir: &Path,
        on_change: impl Fn(Vec<PathBuf>) + Send + 'static,
    ) -> notify_debouncer_full::notify::Result<Self> {
        let mut ignored = walk::IgnoredPaths::new(dir);
        Self::start(dir, RecursiveMode::Recursive, move |paths| {
            let paths: Vec<PathBuf> = paths.into_iter().filter(|p| !ignored.contains(p)).collect();
            if !paths.is_empty() {
                on_change(paths);
            }
        })
    }

    /// Watch one document: `on_change` is called when it is written, replaced
    /// (as editors do by renaming a new file over it), renamed away, created or
    /// deleted. The parent directory is watched rather than the file itself,
    /// since a watch on the file would die when it is replaced.
    pub fn document(
        path: &Path,
        on_change: impl Fn() + Send + 'static,
    ) -> notify_debouncer_full::notify::Result<Self> {
        let dir = path.parent().unwrap_or(Path::new("/"));
        let name = path.file_name().map(|n| n.to_os_string());
        Self::start(dir, RecursiveMode::NonRecursive, move |paths| {
            if paths
                .iter()
                .any(|p| p.file_name().map(|n| n.to_os_string()) == name)
            {
                on_change();
            }
        })
    }

    fn start(
        dir: &Path,
        mode: RecursiveMode,
        mut on_change: impl FnMut(Vec<PathBuf>) + Send + 'static,
    ) -> notify_debouncer_full::notify::Result<Self> {
        let (tx, rx) = mpsc::channel::<DebounceEventResult>();
        // No file-id cache: building one walks the whole folder before the
        // first event, which takes seconds on a large repository. Without it
        // a rename is reported as its old and new path, which is all MINT needs.
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            Duration::from_millis(200),
            None,
            tx,
            NoCache,
            notify_debouncer_full::notify::Config::default(),
        )?;
        debouncer.watch(dir, mode)?;
        let watched = dir.to_path_buf();
        // The platform reports resolved paths (e.g. /private/var for /var on
        // macOS); report them under the folder as the caller named it.
        let resolved = fs::canonicalize(dir).ok().filter(|r| r != dir);
        std::thread::spawn(move || {
            // Ends when the debouncer (and with it the sender) is dropped.
            for result in rx {
                let events = match result {
                    Ok(events) => events,
                    Err(errors) => {
                        // Changes may have been missed; say so instead of failing silently.
                        for e in errors {
                            eprintln!("MINT: watching {} failed: {e}", watched.display());
                        }
                        continue;
                    }
                };
                let mut paths: Vec<PathBuf> = events
                    .into_iter()
                    .flat_map(|e| e.event.paths)
                    .filter(|p| !is_own_temp_file(p))
                    .map(|p| match resolved.as_deref().map(|r| p.strip_prefix(r)) {
                        Some(Ok(rest)) => watched.join(rest),
                        _ => p,
                    })
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

    #[test]
    fn watcher_reports_both_paths_of_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(dir.join("a")).unwrap();
        fs::create_dir(dir.join("b")).unwrap();
        fs::write(dir.join("a").join("old.md"), "x").unwrap();
        let (_watcher, rx) = watch(&dir);

        fs::rename(dir.join("a").join("old.md"), dir.join("b").join("new.md")).unwrap();

        let names = changed_names(&rx);
        assert!(names.contains(&"old.md".to_string()), "{names:?}");
        assert!(names.contains(&"new.md".to_string()), "{names:?}");
    }

    #[test]
    fn watcher_skips_git_internals_and_ignored_paths() {
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        fs::write(dir.join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::create_dir_all(dir.join(".git").join("objects")).unwrap();
        fs::create_dir_all(dir.join("build").join("deep")).unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join(".gitignore"), "local.md\n").unwrap();
        let (_watcher, rx) = watch(&dir);

        fs::write(dir.join(".git").join("index"), "x").unwrap();
        fs::write(dir.join(".git").join("objects").join("ab12"), "x").unwrap();
        fs::write(dir.join("build").join("deep").join("out.o"), "x").unwrap();
        fs::write(dir.join("debug.log"), "x").unwrap();
        fs::write(dir.join("sub").join("local.md"), "x").unwrap();
        fs::write(dir.join("sub").join("shared.md"), "x").unwrap();
        fs::write(dir.join("notes.md"), "x").unwrap();

        let names = changed_names(&rx);
        assert!(names.contains(&"notes.md".to_string()), "{names:?}");
        assert!(names.contains(&"shared.md".to_string()), "{names:?}");
        for hidden in [
            "index",
            "ab12",
            "objects",
            "out.o",
            "deep",
            "debug.log",
            "local.md",
        ] {
            assert!(
                !names.contains(&hidden.to_string()),
                "{hidden} in {names:?}"
            );
        }
    }

    #[test]
    fn watcher_reports_paths_under_the_folder_as_it_was_given() {
        // On macOS the temporary directory is reached through a symbolic link
        // (/var -> /private/var); the reported paths must still start with it.
        let dir = tempfile::tempdir().unwrap();
        let link_parent = tempfile::tempdir().unwrap();
        let link = link_parent.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(dir.path(), &link).unwrap();
        let (_watcher, rx) = watch(&link);

        fs::write(link.join("added.md"), "x").unwrap();

        // The change may arrive in any of several batches (FSEvents can also
        // replay events from just before the watch started).
        let mut paths = Vec::new();
        while let Ok(batch) = rx.recv_timeout(Duration::from_secs(3)) {
            paths.extend(batch);
        }
        assert!(paths.contains(&link.join("added.md")), "{paths:?}");
    }

    /// Write `count` empty files spread over directories of 20 files each.
    #[cfg(not(target_os = "linux"))]
    fn generate_tree(root: &Path, count: usize) {
        for i in 0..count {
            let dir = root
                .join(format!("d{}", i / 20 / 20))
                .join(format!("e{}", i / 20));
            if i % 20 == 0 {
                fs::create_dir_all(&dir).unwrap();
            }
            fs::write(dir.join(format!("f{i}.md")), "").unwrap();
        }
    }

    /// How long starting a folder watcher on `dir` takes.
    #[cfg(not(target_os = "linux"))]
    fn start_time(dir: &Path) -> Duration {
        let started = std::time::Instant::now();
        let _watcher = FolderWatcher::new(dir, |_| {}).unwrap();
        started.elapsed()
    }

    // Not on Linux: inotify itself must add one watch per directory, so starting
    // there grows with the folder whatever MINT does (it runs off the main thread).
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn watcher_starts_without_walking_a_large_folder() {
        let empty = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        generate_tree(&dir, 20_000);

        // What visiting every entry once costs on this machine (cache warm).
        let started = std::time::Instant::now();
        let entries = walkdir_all(&dir)
            .iter()
            .filter(|p| fs::metadata(p).is_ok())
            .count();
        let walk = started.elapsed();
        assert!(entries > 20_000);

        // The platform watcher has a fixed start-up cost (FSEvents: ~0.2 s);
        // what must not happen is a cost that grows with the folder.
        // Best of three, so one slow start on a busy machine doesn't fail it.
        let best = |p: &Path| (0..3).map(|_| start_time(p)).min().unwrap();
        let baseline = best(empty.path());
        let large = best(&dir);

        assert!(
            large < baseline + walk / 2,
            "starting on 20k files took {large:?}, on an empty folder {baseline:?}, a walk takes {walk:?}"
        );
    }

    /// Every path under `root`, depth first.
    #[cfg(not(target_os = "linux"))]
    fn walkdir_all(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for item in fs::read_dir(&dir).unwrap() {
                let path = item.unwrap().path();
                if path.is_dir() {
                    stack.push(path.clone());
                }
                out.push(path);
            }
        }
        out
    }

    /// How long starting a folder watcher takes on a real folder:
    /// `MINT_WATCH_BENCH=~/some/big/folder cargo test -- --ignored --nocapture watcher_start_time`.
    #[test]
    #[ignore]
    fn watcher_start_time_on_a_real_folder() {
        let dir = PathBuf::from(std::env::var("MINT_WATCH_BENCH").expect("MINT_WATCH_BENCH"));
        let started = std::time::Instant::now();
        let watcher = FolderWatcher::new(&dir, |_| {}).unwrap();
        let start = started.elapsed();
        let started = std::time::Instant::now();
        drop(watcher);
        println!(
            "FolderWatcher::new({}) took {start:?}; dropping it took {:?}",
            dir.display(),
            started.elapsed()
        );
    }

    fn watch_document(path: &Path) -> (FolderWatcher, mpsc::Receiver<()>) {
        let (tx, rx) = mpsc::channel();
        let watcher = FolderWatcher::document(path, move || {
            let _ = tx.send(());
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        (watcher, rx)
    }

    fn reported(rx: &mpsc::Receiver<()>) -> bool {
        let got = rx.recv_timeout(Duration::from_secs(3)).is_ok();
        // Drain the rest of the burst.
        while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
        got
    }

    #[test]
    fn document_watcher_reports_edits_renames_over_it_and_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        let path = dir.join("doc.md");
        fs::write(&path, "one").unwrap();
        let (_watcher, rx) = watch_document(&path);

        fs::write(&path, "two").unwrap();
        assert!(reported(&rx), "a plain write");

        // Editors that save by renaming a new file over the document.
        fs::write(dir.join("doc.md.swp"), "three").unwrap();
        fs::rename(dir.join("doc.md.swp"), &path).unwrap();
        assert!(reported(&rx), "a rename over the document");

        fs::rename(&path, dir.join("moved.md")).unwrap();
        assert!(reported(&rx), "a rename away");

        fs::write(&path, "back").unwrap();
        assert!(reported(&rx), "the document coming back");

        fs::remove_file(&path).unwrap();
        assert!(reported(&rx), "a deletion");
    }

    #[test]
    fn document_watcher_ignores_other_files_and_mints_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(dir.path()).unwrap();
        let path = dir.join("doc.md");
        fs::write(&path, "one").unwrap();
        let (_watcher, rx) = watch_document(&path);

        fs::write(dir.join("other.md"), "x").unwrap();
        fs::write(dir.join(".mint-abc.tmp"), "x").unwrap();

        assert!(!reported(&rx));
    }
}
