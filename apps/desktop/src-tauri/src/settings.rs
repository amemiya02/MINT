//! The settings file: one JSON object in the system configuration directory.
//!
//! The backend only reads, writes and watches the file. It reports JSON syntax
//! errors, but knows nothing about individual settings: the schema (defaults,
//! allowed values) lives in the shell, so adding a setting never touches Rust.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify_debouncer_full::notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::fs;

pub const FILE_NAME: &str = "settings.json";

/// What the settings file currently holds, as seen by the shell.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum SettingsFile {
    /// No file yet: every setting has its default.
    Missing,
    /// A JSON object. Values are not validated here.
    Ok { values: Map<String, Value> },
    /// The file cannot be used; `message` says why (e.g. a syntax error with its line).
    Invalid { message: String },
}

/// Read and parse the settings file at `path`.
pub fn load(path: &Path) -> SettingsFile {
    let text = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return SettingsFile::Missing,
        Err(e) => {
            return SettingsFile::Invalid {
                message: e.to_string(),
            }
        }
    };
    match serde_json::from_slice::<Value>(&text) {
        Ok(Value::Object(values)) => SettingsFile::Ok { values },
        Ok(_) => SettingsFile::Invalid {
            message: "the file must contain a JSON object".into(),
        },
        Err(e) => SettingsFile::Invalid {
            message: e.to_string(),
        },
    }
}

/// Write `values` as pretty-printed JSON, atomically, creating the directory if needed.
pub fn save(path: &Path, values: &Map<String, Value>) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut text = serde_json::to_string_pretty(values).map_err(io::Error::other)?;
    text.push('\n');
    fs::write_atomic(path, text.as_bytes())
}

/// Watches the settings file; dropping it stops watching.
pub struct SettingsWatcher {
    _debouncer: Debouncer<notify_debouncer_full::notify::RecommendedWatcher, RecommendedCache>,
}

/// Call `on_change` with the reloaded file whenever `path` is created, changed,
/// replaced (as editors do with an atomic rename) or removed.
///
/// The parent directory is watched rather than the file itself, since a watch on
/// the file would die when an editor renames a new file over it.
pub fn watch(
    path: PathBuf,
    on_change: impl Fn(SettingsFile) + Send + 'static,
) -> io::Result<SettingsWatcher> {
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::other("the settings path has no directory"))?;
    std::fs::create_dir_all(&dir)?;
    let name = path.file_name().map(|n| n.to_os_string());
    let watched = path.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let touches_file = events.iter().any(|event| {
                event
                    .paths
                    .iter()
                    .any(|p| p.file_name().map(|n| n.to_os_string()) == name)
            });
            if touches_file {
                on_change(load(&watched));
            }
        },
    )
    .map_err(io::Error::other)?;
    debouncer
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(io::Error::other)?;
    Ok(SettingsWatcher {
        _debouncer: debouncer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn load_reports_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(load(&dir.path().join(FILE_NAME)), SettingsFile::Missing);
    }

    #[test]
    fn load_returns_the_values_of_a_json_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, r#"{ "language": "zh-CN", "future": [1, 2] }"#).unwrap();

        assert_eq!(
            load(&path),
            SettingsFile::Ok {
                values: object(json!({ "language": "zh-CN", "future": [1, 2] }))
            }
        );
    }

    #[test]
    fn load_reports_a_syntax_error_with_its_position() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, "{\n  \"language\": \"en\"\n  \"x\": 1\n}").unwrap();

        let SettingsFile::Invalid { message } = load(&path) else {
            panic!("expected an invalid file");
        };
        assert!(message.contains("line 3"), "{message}");
    }

    #[test]
    fn load_rejects_json_that_is_not_an_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, "[1, 2]").unwrap();

        assert_eq!(
            load(&path),
            SettingsFile::Invalid {
                message: "the file must contain a JSON object".into()
            }
        );
    }

    #[test]
    fn save_creates_the_directory_and_writes_readable_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config").join(FILE_NAME);
        let values = object(json!({ "language": "en" }));

        save(&path, &values).unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"language\": \"en\"\n}\n"
        );
        assert_eq!(load(&path), SettingsFile::Ok { values });
    }

    #[test]
    fn serializes_for_the_shell_with_a_status_tag() {
        let ok = SettingsFile::Ok {
            values: object(json!({ "language": "en" })),
        };
        assert_eq!(
            serde_json::to_value(ok).unwrap(),
            json!({ "status": "ok", "values": { "language": "en" } })
        );
        assert_eq!(
            serde_json::to_value(SettingsFile::Missing).unwrap(),
            json!({ "status": "missing" })
        );
        assert_eq!(
            serde_json::to_value(SettingsFile::Invalid {
                message: "bad".into()
            })
            .unwrap(),
            json!({ "status": "invalid", "message": "bad" })
        );
    }

    /// Wait for the watcher to report a file matching `wanted`, skipping intermediate events.
    fn expect_event(rx: &mpsc::Receiver<SettingsFile>, wanted: &SettingsFile) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok(file) if &file == wanted => return,
                Ok(_) => continue,
                Err(_) => panic!("no settings event matching {wanted:?}"),
            }
        }
    }

    fn start_watching(path: &Path) -> (SettingsWatcher, mpsc::Receiver<SettingsFile>) {
        let (tx, rx) = mpsc::channel();
        let watcher = watch(path.to_path_buf(), move |file| {
            let _ = tx.send(file);
        })
        .unwrap();
        // Give the platform watcher (FSEvents on macOS) time to start.
        std::thread::sleep(Duration::from_millis(300));
        (watcher, rx)
    }

    #[test]
    fn watch_reports_edits_made_by_other_programs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, r#"{ "language": "en" }"#).unwrap();
        let (_watcher, rx) = start_watching(&path);

        std::fs::write(&path, r#"{ "language": "zh-CN" }"#).unwrap();

        expect_event(
            &rx,
            &SettingsFile::Ok {
                values: object(json!({ "language": "zh-CN" })),
            },
        );
    }

    #[test]
    fn watch_follows_editors_that_save_by_renaming_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, r#"{ "language": "en" }"#).unwrap();
        let (_watcher, rx) = start_watching(&path);

        let values = object(json!({ "language": "zh-CN" }));
        save(&path, &values).unwrap();
        expect_event(&rx, &SettingsFile::Ok { values });

        // The watch survives the rename: a second edit is reported too.
        std::fs::write(&path, "{ oops").unwrap();
        let broken = load(&path);
        assert!(matches!(broken, SettingsFile::Invalid { .. }));
        expect_event(&rx, &broken);
    }

    #[test]
    fn watch_reports_a_deleted_file_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, r#"{ "language": "en" }"#).unwrap();
        let (_watcher, rx) = start_watching(&path);

        std::fs::remove_file(&path).unwrap();

        expect_event(&rx, &SettingsFile::Missing);
    }

    #[test]
    fn watch_ignores_other_files_in_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let (_watcher, rx) = start_watching(&path);

        std::fs::write(dir.path().join("other.json"), "{}").unwrap();

        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
    }
}
