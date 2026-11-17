//! MINT's Rust backend. It stays thin (ADR-0005): only what the web layer
//! cannot do well lives here. Each IPC command is a small wrapper over a plain
//! function that is unit-tested with `cargo test`.

mod fs;
mod settings;

use std::path::PathBuf;

use serde_json::{Map, Value};
use tauri::{Emitter, Manager, State};

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

/// Event sent to every window with the reloaded `SettingsFile` whenever the file changes on disk.
const SETTINGS_CHANGED: &str = "settings-changed";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            settings_path,
            read_settings,
            write_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running MINT");
}
