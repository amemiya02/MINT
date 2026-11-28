//! Ordinary writing reviews and their private task directories.

use crate::{app_data_dir, blocking};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

const RECORD: &str = "review.json";
// Serialize task directory changes and record which directories have an Agent using them.
static TASKS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritingTask {
    version: u32,
    id: String,
    path: Option<String>,
    updated_at: u64,
    #[serde(flatten)]
    review: serde_json::Map<String, Value>,
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let ai = app_data_dir(app)?.join("ai");
    let tasks = ai.join("tasks");
    for directory in [&ai, &tasks] {
        match fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Err("invalid writing tasks directory".to_owned()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(tasks)
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn task_directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid writing task ID".to_owned());
    }
    Ok(root.join(id))
}

fn is_task_directory(directory: &Path) -> bool {
    fs::symlink_metadata(directory).is_ok_and(|metadata| metadata.is_dir())
}

fn is_task_record(record: &Path) -> bool {
    fs::symlink_metadata(record).is_ok_and(|metadata| metadata.is_file())
}

fn read_record(record: &Path) -> Result<Option<WritingTask>, String> {
    if !is_task_record(record) {
        return Ok(None);
    }
    match fs::read_to_string(record) {
        Ok(json) => Ok(serde_json::from_str(&json).ok()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn records(root: &Path) -> Result<Vec<(PathBuf, WritingTask)>, String> {
    let directories = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut tasks = Vec::new();
    for entry in directories {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        let Some(id) = name.to_str().filter(|name| valid_id(name)) else {
            continue;
        };
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let record = entry.path().join(RECORD);
        if let Some(task) = read_record(&record)? {
            if task.version == 1 && task.id == id {
                tasks.push((record, task));
            }
        }
    }
    Ok(tasks)
}

fn save(
    root: &Path,
    mut task: WritingTask,
    expected_updated_at: Option<u64>,
) -> Result<(), String> {
    let directory = task_directory(root, &task.id)?;
    let record = directory.join(RECORD);
    let _guard = TASKS.lock().map_err(|error| error.to_string())?;
    if let Some(expected) = expected_updated_at {
        if !is_task_directory(&directory) {
            return Err("writing task no longer exists".to_owned());
        }
        let previous = read_record(&record)?.ok_or("writing task no longer exists")?;
        if previous.updated_at != expected || task.updated_at <= expected {
            return Err("writing task changed".to_owned());
        }
        // The file move owns changes to a saved path. A queued checkpoint can
        // still refer to the old path. Untitled tasks acquire a path on save.
        task.path = previous.path.or(task.path);
    }
    let json = serde_json::to_vec(&task).map_err(|error| error.to_string())?;
    let create = expected_updated_at.is_none();
    if create {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
    }
    if let Err(error) = crate::fs::write_atomic_at(&record, &json) {
        if create {
            let _ = fs::remove_dir(&directory);
        }
        return Err(error.to_string());
    }
    Ok(())
}

pub fn relocate(
    app: &AppHandle,
    from: &Path,
    to: &Path,
    commit: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let root = root(app).map_err(io::Error::other)?;
    let _guard = TASKS
        .lock()
        .map_err(|error| io::Error::other(error.to_string()))?;
    let mut staged = Vec::new();
    let result = (|| {
        for (record, mut task) in records(&root).map_err(io::Error::other)? {
            let Some(path) = task.path.as_deref() else {
                continue;
            };
            let Ok(relative) = Path::new(path).strip_prefix(from) else {
                continue;
            };
            let destination = if relative.as_os_str().is_empty() {
                to.to_owned()
            } else {
                to.join(relative)
            };
            let original = serde_json::to_vec(&task).map_err(io::Error::other)?;
            task.path = Some(destination.to_string_lossy().into_owned());
            let relocated = serde_json::to_vec(&task).map_err(io::Error::other)?;
            crate::fs::write_atomic_at(&record, &relocated)?;
            staged.push((record, original));
        }
        commit()
    })();
    if let Err(error) = result {
        let mut failures = Vec::new();
        for (record, original) in staged {
            if let Err(problem) = crate::fs::write_atomic_at(&record, &original) {
                failures.push(problem.to_string());
            }
        }
        if !failures.is_empty() {
            return Err(io::Error::other(format!(
                "{error}; restoring writing tasks: {}",
                failures.join(", ")
            )));
        }
        return Err(error);
    }
    Ok(())
}

pub struct AgentScratch {
    scratch: Option<tempfile::TempDir>,
    task: Option<PathBuf>,
}

impl AgentScratch {
    pub fn path(&self) -> &Path {
        self.scratch.as_ref().expect("Agent scratch is live").path()
    }
}

impl Drop for AgentScratch {
    fn drop(&mut self) {
        drop(self.scratch.take());
        if let Some(task) = &self.task {
            if let Ok(mut active) = TASKS.lock() {
                active.retain(|directory| directory != task);
            }
        }
    }
}

pub fn agent_scratch(app: &AppHandle, id: Option<&str>) -> Result<AgentScratch, String> {
    let Some(id) = id else {
        return Ok(AgentScratch {
            scratch: Some(tempfile::tempdir().map_err(|error| error.to_string())?),
            task: None,
        });
    };
    let directory = task_directory(&root(app)?, id)?;
    let mut active = TASKS.lock().map_err(|error| error.to_string())?;
    if !is_task_directory(&directory)
        || !is_task_record(&directory.join(RECORD))
        || active.contains(&directory)
    {
        return Err("writing task cannot start an Agent run".to_owned());
    }
    let scratch = tempfile::Builder::new()
        .prefix(".agent-")
        .tempdir_in(&directory)
        .map_err(|error| error.to_string())?;
    active.push(directory.clone());
    Ok(AgentScratch {
        scratch: Some(scratch),
        task: Some(directory),
    })
}

fn delete(root: &Path, id: &str) -> Result<(), String> {
    let directory = task_directory(root, id)?;
    let active = TASKS.lock().map_err(|error| error.to_string())?;
    if active.contains(&directory) {
        return Err("writing task still has an active Agent run".to_owned());
    }
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err("invalid writing task directory".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    }

    // Keep the record available for another deletion attempt if a copy cannot be removed.
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name() == RECORD {
            continue;
        }
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
        } else {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    fs::remove_dir_all(directory).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_writing_tasks(
    app: AppHandle,
    path: Option<String>,
) -> Result<Vec<WritingTask>, String> {
    blocking(move || {
        let root = root(&app)?;
        let _guard = TASKS.lock().map_err(|error| error.to_string())?;
        Ok(records(&root)?
            .into_iter()
            .filter_map(|(_, task)| (task.path == path).then_some(task))
            .collect())
    })
    .await
}

#[derive(Serialize)]
pub struct ReviewLink {
    id: String,
    path: String,
    title: String,
}

#[tauri::command]
pub async fn list_writing_reviews_in_folder(
    app: AppHandle,
    folder: String,
) -> Result<Vec<ReviewLink>, String> {
    blocking(move || {
        let root = root(&app)?;
        let _guard = TASKS.lock().map_err(|error| error.to_string())?;
        Ok(records(&root)?
            .into_iter()
            .filter_map(|(_, task)| {
                let path = task
                    .path
                    .filter(|path| Path::new(path).starts_with(&folder))?;
                let has_edits = task.review.get("turns")?.as_array()?.iter().any(|turn| {
                    turn.get("suggestions")
                        .and_then(Value::as_array)
                        .is_some_and(|suggestions| !suggestions.is_empty())
                });
                has_edits.then(|| ReviewLink {
                    id: task.id,
                    path,
                    title: task
                        .review
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                })
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn create_writing_task(app: AppHandle, task: WritingTask) -> Result<(), String> {
    blocking(move || save(&root(&app)?, task, None)).await
}

#[tauri::command]
pub async fn update_writing_task(
    app: AppHandle,
    task: WritingTask,
    expected_updated_at: u64,
) -> Result<(), String> {
    blocking(move || save(&root(&app)?, task, Some(expected_updated_at))).await
}

#[tauri::command]
pub async fn delete_writing_task(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || delete(&root(&app)?, &id)).await
}
