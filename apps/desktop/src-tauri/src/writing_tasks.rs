//! Ordinary writing reviews and their private task directories.

use crate::{app_data, app_data_dir, blocking};
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
    #[serde(flatten)]
    review: serde_json::Map<String, Value>,
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("ai").join("tasks"))
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

fn list(root: &Path, path: Option<String>) -> Result<Vec<WritingTask>, String> {
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
        let Some(json) =
            app_data::read(&entry.path(), RECORD).map_err(|error| error.to_string())?
        else {
            continue;
        };
        if let Ok(task) = serde_json::from_str::<WritingTask>(&json) {
            if task.version == 1 && task.id == id && task.path == path {
                tasks.push(task);
            }
        }
    }
    Ok(tasks)
}

fn save(root: &Path, task: &WritingTask, create: bool) -> Result<(), String> {
    let directory = task_directory(root, &task.id)?;
    let json = serde_json::to_string(task).map_err(|error| error.to_string())?;
    let _guard = TASKS.lock().map_err(|error| error.to_string())?;
    if create {
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
    } else if !is_task_directory(&directory) || !directory.join(RECORD).is_file() {
        return Err("writing task no longer exists".to_owned());
    }
    if let Err(error) = app_data::write(&directory, RECORD, &json) {
        if create {
            let _ = fs::remove_dir(&directory);
        }
        return Err(error.to_string());
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
        || !directory.join(RECORD).is_file()
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
    blocking(move || list(&root(&app)?, path)).await
}

#[tauri::command]
pub async fn create_writing_task(app: AppHandle, task: WritingTask) -> Result<(), String> {
    blocking(move || save(&root(&app)?, &task, true)).await
}

#[tauri::command]
pub async fn update_writing_task(app: AppHandle, task: WritingTask) -> Result<(), String> {
    blocking(move || save(&root(&app)?, &task, false)).await
}

#[tauri::command]
pub async fn delete_writing_task(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || delete(&root(&app)?, &id)).await
}
