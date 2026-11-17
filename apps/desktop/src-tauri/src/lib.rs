//! MINT's Rust backend. It stays thin (ADR-0005): only what the web layer
//! cannot do well lives here. Each IPC command is a small wrapper over a plain
//! function that is unit-tested with `cargo test`.

mod fs;

use std::path::PathBuf;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_text_file, write_text_file])
        .run(tauri::generate_context!())
        .expect("error while running MINT");
}
