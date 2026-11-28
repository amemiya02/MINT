//! Immutable UTF-8 snapshots, kept outside the user's working folder.
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fs;

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
    static WRITER: Mutex<()> = Mutex::new(());
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
