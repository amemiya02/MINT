//! MINT's Rust backend. It stays thin (ADR-0005): only what the web layer
//! cannot do well lives here. Each IPC command is a small wrapper over a plain
//! function that is unit-tested with `cargo test`.

mod app_data;
mod folder;
mod fs;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// Read a document as UTF-8 text, keeping a BOM and line endings as they are.
#[tauri::command]
fn read_text_file(path: PathBuf) -> Result<String, String> {
    fs::read_text(&path).map_err(|e| e.to_string())
}

/// Write a document atomically (temporary file + rename).
#[tauri::command]
fn write_text_file(path: PathBuf, text: String) -> Result<(), String> {
    fs::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_directory(path: PathBuf) -> Result<Vec<folder::Entry>, String> {
    folder::list_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(path: PathBuf) -> Result<(), String> {
    folder::create_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_directory(path: PathBuf) -> Result<(), String> {
    folder::create_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(from: PathBuf, to: PathBuf) -> Result<(), String> {
    folder::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn move_to_trash(path: PathBuf) -> Result<(), String> {
    folder::move_to_trash(&path).map_err(|e| e.to_string())
}

/// Live folder watchers, by id. Dropping a watcher stops it.
#[derive(Default)]
struct Watchers {
    next_id: AtomicU32,
    active: Mutex<HashMap<u32, folder::FolderWatcher>>,
}

/// Watch a folder recursively; each debounced batch of changed paths is sent on `on_change`.
#[tauri::command]
fn watch_folder(
    path: PathBuf,
    on_change: Channel<Vec<PathBuf>>,
    watchers: State<'_, Watchers>,
) -> Result<u32, String> {
    let watcher = folder::FolderWatcher::new(&path, move |paths| {
        let _ = on_change.send(paths);
    })
    .map_err(|e| e.to_string())?;
    let id = watchers.next_id.fetch_add(1, Ordering::Relaxed);
    watchers
        .active
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, watcher);
    Ok(id)
}

#[tauri::command]
fn unwatch_folder(id: u32, watchers: State<'_, Watchers>) -> Result<(), String> {
    watchers
        .active
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    Ok(())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn read_app_data(app: AppHandle, name: String) -> Result<Option<String>, String> {
    app_data::read(&app_data_dir(&app)?, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_app_data(app: AppHandle, name: String, text: String) -> Result<(), String> {
    app_data::write(&app_data_dir(&app)?, &name, &text).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Watchers::default())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            read_directory,
            create_file,
            create_directory,
            rename_path,
            move_to_trash,
            watch_folder,
            unwatch_folder,
            read_app_data,
            write_app_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MINT");
}
