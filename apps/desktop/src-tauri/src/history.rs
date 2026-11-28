//! Immutable UTF-8 snapshots, kept outside the user's working folder.
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fs;

static WRITER: Mutex<()> = Mutex::new(());

pub fn directory(data: &Path, document: &Path) -> PathBuf {
    let key = Sha256::digest(document.as_os_str().as_encoded_bytes());
    data.join("history").join(format!("{key:x}"))
}

/// Millisecond timestamps also identify and order versions.
pub fn versions(dir: &Path) -> io::Result<Vec<u64>> {
    let entries = match std::fs::read_dir(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        result => result?,
    };
    let mut ids = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "md") {
            if let Some(id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse().ok())
            {
                ids.push(id);
            }
        }
    }
    ids.sort_unstable();
    Ok(ids)
}

pub fn read(dir: &Path, id: u64) -> io::Result<String> {
    fs::read_text(&dir.join(format!("{id}.md")))
}

pub fn record(dir: &Path, text: &str) -> io::Result<()> {
    // Windows of the same app can save simultaneously.
    let _guard = WRITER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    std::fs::create_dir_all(dir)?;
    let mut id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_millis() as u64;
    if let Some(last) = versions(dir)?.last() {
        if read(dir, *last)? == text {
            return Ok(());
        }
        id = id.max(
            last.checked_add(1)
                .ok_or_else(|| io::Error::other("version id overflow"))?,
        );
    }
    fs::write_atomic(&dir.join(format!("{id}.md")), text.as_bytes())
}

// Share the document's private data directory so a move carries the annotations
// along with the versions, without adding any files to the working folder.
const ANNOTATIONS: &str = "annotations.json";

pub fn read_annotations(dir: &Path) -> io::Result<Map<String, Value>> {
    match crate::app_data::read(dir, ANNOTATIONS)? {
        Some(text) => serde_json::from_str(&text).map_err(io::Error::other),
        None => Ok(Map::new()),
    }
}

pub fn update_annotations(dir: &Path, changes: Map<String, Value>) -> io::Result<()> {
    let _guard = WRITER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut annotations = read_annotations(dir)?;
    annotations.extend(changes);
    crate::app_data::write(
        dir,
        ANNOTATIONS,
        &serde_json::to_string(&annotations).map_err(io::Error::other)?,
    )
}

/// Transfer legacy path-keyed snapshots under the same writer lock as saves.
/// Stage the history changes first so a failed move (including undo) can
/// restore the previous keys without having to rewrite the manuscript.
pub fn relocate(
    data: &Path,
    from: &Path,
    to: &Path,
    commit: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    if from == to {
        return commit();
    }
    let _guard = WRITER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let root = data.join("history");
    if !root.try_exists()? {
        return commit();
    }
    let mut pending = vec![(from.to_owned(), to.to_owned())];
    let mut moved = Vec::new();
    let mut detached = None;
    let result = (|| {
        while let Some((old, new)) = pending.pop() {
            let kind = std::fs::symlink_metadata(&old)?.file_type();
            if kind.is_dir() {
                for entry in std::fs::read_dir(&old)? {
                    let entry = entry?;
                    pending.push((entry.path(), new.join(entry.file_name())));
                }
            } else if kind.is_file() {
                let src = directory(data, &old);
                let dest = directory(data, &new);
                if dest.try_exists()? {
                    // A previously deleted document may have used the destination.
                    // Retain its snapshots separately from the incoming document.
                    if detached.is_none() {
                        detached = Some(
                            tempfile::Builder::new()
                                .prefix("detached-")
                                .tempdir_in(&root)?,
                        );
                    }
                    let saved = detached
                        .as_ref()
                        .unwrap()
                        .path()
                        .join(dest.file_name().unwrap());
                    std::fs::rename(&dest, &saved)?;
                    moved.push((dest.clone(), saved));
                }
                if src.try_exists()? {
                    std::fs::rename(&src, &dest)?;
                    moved.push((src, dest));
                }
            }
        }
        commit()
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for (original, staged) in moved.into_iter().rev() {
            if let Err(e) = std::fs::rename(&staged, &original) {
                failures.push(format!("{}: {e}", staged.display()));
            }
        }
        if failures.is_empty() {
            return Err(error);
        }
        if let Some(dir) = detached {
            let _ = dir.keep();
        }
        return Err(io::Error::other(format!(
            "{error}; restoring history: {}",
            failures.join(", ")
        )));
    }
    if let Some(dir) = detached {
        let _ = dir.keep();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_move_transfers_existing_history_and_failed_undo_restores_its_keys() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("app-data");
        let from = temp.path().join("notes");
        let to = temp.path().join("archive");
        std::fs::create_dir(&from).unwrap();
        std::fs::write(from.join("draft.md"), "current").unwrap();
        let old = directory(&data, &from.join("draft.md"));
        let new = directory(&data, &to.join("draft.md"));
        record(&old, "first draft").unwrap();
        record(&new, "previous occupant").unwrap();
        let id = versions(&old).unwrap()[0];
        relocate(&data, &from, &to, || std::fs::rename(&from, &to)).unwrap();
        assert_eq!(read(&new, id).unwrap(), "first draft");
        assert_eq!(versions(&new).unwrap(), [id]);
        assert!(versions(&old).unwrap().is_empty());
        assert!(relocate(&data, &to, &from, || Err(io::Error::other("changed"))).is_err());
        assert_eq!(read(&new, id).unwrap(), "first draft");
        relocate(&data, &to, &from, || std::fs::rename(&to, &from)).unwrap();
        assert_eq!(read(&old, id).unwrap(), "first draft");
        assert!(versions(&new).unwrap().is_empty());
    }
}
