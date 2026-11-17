//! MINT's Rust backend. It stays thin (ADR-0005): only what the web layer
//! cannot do well lives here. Each IPC command is a small wrapper over a plain
//! function that is unit-tested with `cargo test`.

mod app_data;
mod folder;
mod fs;
mod recovery;
mod settings;
mod walk;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

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

/// Where the settings file lives, plus the watcher that keeps it alive.
struct SettingsState {
    path: PathBuf,
    _watcher: Option<settings::SettingsWatcher>,
}

#[tauri::command]
fn settings_path(state: State<'_, SettingsState>) -> PathBuf {
    state.path.clone()
}

#[tauri::command]
fn read_settings(state: State<'_, SettingsState>) -> settings::SettingsFile {
    settings::load(&state.path)
}

#[tauri::command]
fn write_settings(
    state: State<'_, SettingsState>,
    values: Map<String, Value>,
) -> Result<(), String> {
    settings::save(&state.path, &values).map_err(|e| e.to_string())
}

/// Snapshots of unsaved work left by an earlier run; only the first caller gets them.
#[tauri::command]
fn take_recovery_snapshots(area: State<'_, recovery::RecoveryArea>) -> Vec<recovery::Snapshot> {
    area.take_left_over()
}

#[tauri::command]
fn write_recovery_snapshot(
    area: State<'_, recovery::RecoveryArea>,
    id: String,
    contents: String,
) -> Result<(), String> {
    area.write(&id, &contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_recovery_snapshot(
    area: State<'_, recovery::RecoveryArea>,
    id: String,
) -> Result<(), String> {
    area.remove(&id).map_err(|e| e.to_string())
}

/// Event sent to every window with the reloaded `SettingsFile` whenever the file changes on disk.
const SETTINGS_CHANGED: &str = "settings-changed";

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

/// Every file of a folder, recursively, except entries ignored by `.gitignore`
/// and hidden ones; only those with one of `extensions` unless it is empty.
#[tauri::command]
fn list_folder_files(path: PathBuf, extensions: Vec<String>) -> Vec<PathBuf> {
    walk::list_files(&path, &extensions)
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join(settings::FILE_NAME);
            let handle = app.handle().clone();
            let watcher = settings::watch(path.clone(), move |file| {
                let _ = handle.emit(SETTINGS_CHANGED, file);
            })
            .inspect_err(|e| eprintln!("MINT: cannot watch the settings file: {e}"))
            .ok();
            app.manage(SettingsState {
                path,
                _watcher: watcher,
            });
            let recovery_dir = app.path().app_data_dir()?.join(recovery::DIR_NAME);
            app.manage(recovery::RecoveryArea::open(recovery_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            settings_path,
            read_settings,
            write_settings,
            read_directory,
            create_file,
            create_directory,
            rename_path,
            move_to_trash,
            list_folder_files,
            watch_folder,
            unwatch_folder,
            read_app_data,
            write_app_data,
            take_recovery_snapshots,
            write_recovery_snapshot,
            delete_recovery_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running MINT");
}
