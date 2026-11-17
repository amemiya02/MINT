//! The recovery area: a directory in the application data directory where the
//! shell keeps snapshots of unsaved work, so it survives a crash. It is never
//! inside a working folder.
//!
//! The backend only stores, lists and removes snapshots; what a snapshot holds
//! is up to the shell.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::fs;

/// Name of the recovery area inside the application data directory.
pub const DIR_NAME: &str = "recovery";

const EXTENSION: &str = "json";

/// One snapshot in the recovery area.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub id: String,
    pub contents: String,
}

/// The recovery area of this run, remembering which snapshots an earlier run left behind.
pub struct RecoveryArea {
    dir: PathBuf,
    left_over: Mutex<Option<Vec<Snapshot>>>,
}

impl RecoveryArea {
    /// Open the recovery area at `dir`. Every snapshot already there was left by
    /// an earlier run that did not exit cleanly (a clean exit leaves none).
    pub fn open(dir: PathBuf) -> Self {
        let left_over = list(&dir)
            .inspect_err(|e| eprintln!("MINT: cannot read the recovery area: {e}"))
            .unwrap_or_default();
        Self {
            dir,
            left_over: Mutex::new(Some(left_over)),
        }
    }

    /// The snapshots left by an earlier run. Only the first call returns them, so
    /// that only the first window offers to restore them.
    pub fn take_left_over(&self) -> Vec<Snapshot> {
        self.left_over
            .lock()
            .map(|mut left_over| left_over.take().unwrap_or_default())
            .unwrap_or_default()
    }

    /// Create or replace a snapshot, atomically.
    pub fn write(&self, id: &str, contents: &str) -> io::Result<()> {
        let path = self.path_of(id)?;
        std::fs::create_dir_all(&self.dir)?;
        fs::write_atomic(&path, contents.as_bytes())
    }

    /// Remove a snapshot. Removing one that does not exist succeeds.
    pub fn remove(&self, id: &str) -> io::Result<()> {
        match std::fs::remove_file(self.path_of(id)?) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }

    fn path_of(&self, id: &str) -> io::Result<PathBuf> {
        if !is_valid_id(id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid recovery snapshot id: {id:?}"),
            ));
        }
        Ok(self.dir.join(format!("{id}.{EXTENSION}")))
    }
}

/// Ids become file names, so they are restricted to characters that are safe
/// everywhere and cannot name another directory.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Every snapshot in `dir`. A missing directory holds none; other files are ignored.
fn list(dir: &Path) -> io::Result<Vec<Snapshot>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut snapshots = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some(EXTENSION) {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_valid_id(id) {
            continue;
        }
        match fs::read_text(&path) {
            Ok(contents) => snapshots.push(Snapshot {
                id: id.to_owned(),
                contents,
            }),
            Err(e) => eprintln!("MINT: skipping unreadable recovery snapshot {path:?}: {e}"),
        }
    }
    snapshots.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(snapshots)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area_dir(root: &Path) -> PathBuf {
        root.join("app-data").join(DIR_NAME)
    }

    fn snapshot(id: &str, contents: &str) -> Snapshot {
        Snapshot {
            id: id.into(),
            contents: contents.into(),
        }
    }

    #[test]
    fn a_fresh_area_has_nothing_left_over() {
        let root = tempfile::tempdir().unwrap();

        let area = RecoveryArea::open(area_dir(root.path()));

        assert_eq!(area.take_left_over(), vec![]);
    }

    #[test]
    fn snapshots_written_in_one_run_are_left_over_for_the_next() {
        let root = tempfile::tempdir().unwrap();
        let first_run = RecoveryArea::open(area_dir(root.path()));
        first_run.write("session-1", "{\"text\":\"a\"}").unwrap();
        first_run.write("session-2", "old").unwrap();
        first_run.write("session-2", "new").unwrap();
        // The run crashes: nothing is removed.

        let next_run = RecoveryArea::open(area_dir(root.path()));

        assert_eq!(
            next_run.take_left_over(),
            vec![
                snapshot("session-1", "{\"text\":\"a\"}"),
                snapshot("session-2", "new")
            ]
        );
    }

    #[test]
    fn left_over_snapshots_are_handed_out_once() {
        let root = tempfile::tempdir().unwrap();
        RecoveryArea::open(area_dir(root.path()))
            .write("s", "x")
            .unwrap();
        let area = RecoveryArea::open(area_dir(root.path()));

        assert_eq!(area.take_left_over(), vec![snapshot("s", "x")]);
        assert_eq!(area.take_left_over(), vec![]);
    }

    #[test]
    fn snapshots_written_during_this_run_are_not_left_over() {
        let root = tempfile::tempdir().unwrap();
        let area = RecoveryArea::open(area_dir(root.path()));

        area.write("live", "x").unwrap();

        assert_eq!(area.take_left_over(), vec![]);
    }

    #[test]
    fn removed_snapshots_are_gone_and_removing_twice_is_fine() {
        let root = tempfile::tempdir().unwrap();
        let area = RecoveryArea::open(area_dir(root.path()));
        area.write("a", "x").unwrap();
        area.write("b", "y").unwrap();

        area.remove("a").unwrap();
        area.remove("a").unwrap();

        let next_run = RecoveryArea::open(area_dir(root.path()));
        assert_eq!(next_run.take_left_over(), vec![snapshot("b", "y")]);
    }

    #[test]
    fn ids_that_could_escape_the_area_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let area = RecoveryArea::open(area_dir(root.path()));

        for id in ["", "../evil", "a/b", "a.b", "..", "名前"] {
            let error = area.write(id, "x").unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{id}");
            assert_eq!(
                area.remove(id).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
        assert!(!root.path().join("evil.json").exists());
    }

    #[test]
    fn other_files_in_the_area_are_ignored() {
        let root = tempfile::tempdir().unwrap();
        let dir = area_dir(root.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".mint-abc.tmp"), "partial").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        std::fs::write(dir.join("ok.json"), "y").unwrap();

        let area = RecoveryArea::open(dir);

        assert_eq!(area.take_left_over(), vec![snapshot("ok", "y")]);
    }

    #[test]
    fn serializes_for_the_shell() {
        assert_eq!(
            serde_json::to_value(snapshot("s", "c")).unwrap(),
            serde_json::json!({ "id": "s", "contents": "c" })
        );
    }
}
