//! MINT's Rust backend. It stays thin (ADR-0005): only what the web layer
//! cannot do well lives here. Each IPC command is a small wrapper over a plain
//! function that is unit-tested with `cargo test`.

mod app_data;
mod assets;
mod folder;
mod fs;
mod grants;
mod opened;
mod recovery;
mod search;
mod settings;
mod themes;
mod updates;
mod walk;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use grants::{Grant, Grants};

/// Fail with a readable message unless `path` lies within a root the user granted.
fn granted(grants: &Grants, path: &std::path::Path) -> Result<(), String> {
    grants.check(path).map(|_| ()).map_err(|e| e.to_string())
}

/// Let the page load images (through the asset protocol) from a newly granted root.
fn allow_assets(app: &AppHandle, grant: &Grant) {
    let scope = app.asset_protocol_scope();
    let result = match grant {
        Grant::Directory(dir) => scope.allow_directory(dir, true),
        Grant::File(file) => scope.allow_file(file),
    };
    if let Err(e) = result {
        eprintln!("MINT: cannot allow images from {grant:?}: {e}");
    }
}

fn grant_document(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    let grants = app.state::<Grants>();
    for grant in grants.grant_document(path).map_err(|e| e.to_string())? {
        allow_assets(app, &grant);
    }
    Ok(())
}

fn grant_folder(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    let grant = app
        .state::<Grants>()
        .grant_folder(path)
        .map_err(|e| e.to_string())?;
    allow_assets(app, &grant);
    Ok(())
}

/// A file type filter of a file dialog.
#[derive(serde::Deserialize)]
struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

fn file_dialog(
    window: &WebviewWindow,
    title: String,
    filters: &[DialogFilter],
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut dialog = window.dialog().file().set_title(title).set_parent(window);
    for filter in filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    dialog
}

fn picked(path: Option<tauri_plugin_dialog::FilePath>) -> Result<Option<PathBuf>, String> {
    path.map(|p| p.into_path().map_err(|e| e.to_string()))
        .transpose()
}

/// Ask the user to pick a document; the pick grants its directory.
#[tauri::command]
async fn show_open_dialog(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
    filters: Vec<DialogFilter>,
) -> Result<Option<PathBuf>, String> {
    let dialog = file_dialog(&window, title, &filters);
    let path = picked(
        tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
            .await
            .map_err(|e| e.to_string())?,
    )?;
    if let Some(path) = &path {
        grant_document(&app, path)?;
    }
    Ok(path)
}

/// Ask the user where to save a file; the choice grants its directory.
#[tauri::command]
async fn show_save_dialog(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
    default_path: PathBuf,
    filters: Vec<DialogFilter>,
) -> Result<Option<PathBuf>, String> {
    let mut dialog = file_dialog(&window, title, &filters);
    if let Some(dir) = default_path.parent().filter(|d| d.is_absolute()) {
        dialog = dialog.set_directory(dir);
    }
    if let Some(name) = default_path.file_name() {
        dialog = dialog.set_file_name(name.to_string_lossy());
    }
    let path = picked(
        tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
            .await
            .map_err(|e| e.to_string())?,
    )?;
    if let Some(path) = &path {
        grant_document(&app, path)?;
    }
    Ok(path)
}

/// Ask the user to pick a folder; the pick grants it.
#[tauri::command]
async fn show_open_folder_dialog(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
) -> Result<Option<PathBuf>, String> {
    let dialog = file_dialog(&window, title, &[]);
    let path = picked(
        tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
            .await
            .map_err(|e| e.to_string())?,
    )?;
    if let Some(path) = &path {
        grant_folder(&app, path)?;
    }
    Ok(path)
}

/// Event telling the windows that paths from outside wait in [`opened::Pending`].
const PATHS_OPENED: &str = "paths-opened";

/// Paths handed to MINT from outside (file association, command line, a second
/// launch): grant them, queue them for a window and tell the windows.
fn open_from_outside(app: &AppHandle, paths: Vec<PathBuf>) {
    let mut accepted = Vec::new();
    for opened in paths.into_iter().filter_map(opened::OpenedPath::of) {
        let result = match opened.kind {
            folder::EntryKind::Directory => grant_folder(app, &opened.path),
            folder::EntryKind::File => grant_document(app, &opened.path),
        };
        match result {
            Ok(()) => accepted.push(opened),
            Err(e) => eprintln!("MINT: cannot open {}: {e}", opened.path.display()),
        }
    }
    if accepted.is_empty() {
        return;
    }
    app.state::<opened::Pending>().push(accepted);
    if let Err(e) = app.emit(PATHS_OPENED, ()) {
        eprintln!("MINT: cannot tell the windows about opened paths: {e}");
    }
}

/// The paths from outside that no window has opened yet; only the first caller gets them.
#[tauri::command]
fn take_opened_paths(pending: State<'_, opened::Pending>) -> Vec<opened::OpenedPath> {
    pending.take()
}

/// Read a document as UTF-8 text, keeping a BOM and line endings as they are.
#[tauri::command]
fn read_text_file(grants: State<'_, Grants>, path: PathBuf) -> Result<String, String> {
    granted(&grants, &path)?;
    fs::read_text(&path).map_err(|e| e.to_string())
}

/// Write a document atomically (temporary file + rename).
#[tauri::command]
fn write_text_file(grants: State<'_, Grants>, path: PathBuf, text: String) -> Result<(), String> {
    granted(&grants, &path)?;
    fs::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())
}

/// Save a pasted or dropped asset (base64 `data`) under a name that is not
/// taken yet in `directory`; returns the new file's path.
#[tauri::command]
fn save_asset(
    grants: State<'_, Grants>,
    directory: PathBuf,
    file_name: String,
    data: String,
) -> Result<PathBuf, String> {
    use base64::Engine as _;
    granted(&grants, &directory)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    assets::save(&directory, &file_name, &bytes).map_err(|e| e.to_string())
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

/// Whether this copy of MINT can check for and install new versions itself.
#[tauri::command]
fn updates_supported(app: tauri::AppHandle) -> bool {
    updates::supported(
        app.config().plugins.0.get("updater"),
        updates::Build::current(),
    )
}

/// Event sent to every window with the reloaded `SettingsFile` whenever the file changes on disk.
const SETTINGS_CHANGED: &str = "settings-changed";

#[tauri::command]
fn read_directory(grants: State<'_, Grants>, path: PathBuf) -> Result<Vec<folder::Entry>, String> {
    granted(&grants, &path)?;
    folder::list_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(grants: State<'_, Grants>, path: PathBuf) -> Result<(), String> {
    granted(&grants, &path)?;
    folder::create_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_directory(grants: State<'_, Grants>, path: PathBuf) -> Result<(), String> {
    granted(&grants, &path)?;
    folder::create_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(grants: State<'_, Grants>, from: PathBuf, to: PathBuf) -> Result<(), String> {
    granted(&grants, &from)?;
    granted(&grants, &to)?;
    folder::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn move_to_trash(grants: State<'_, Grants>, path: PathBuf) -> Result<(), String> {
    granted(&grants, &path)?;
    folder::move_to_trash(&path).map_err(|e| e.to_string())
}

/// Every file of a folder, recursively, except entries ignored by `.gitignore`
/// and hidden ones; only those with one of `extensions` unless it is empty.
#[tauri::command]
fn list_folder_files(
    grants: State<'_, Grants>,
    path: PathBuf,
    extensions: Vec<String>,
) -> Result<Vec<PathBuf>, String> {
    granted(&grants, &path)?;
    Ok(walk::list_files(&path, &extensions))
}

/// Running global searches, by id, each with its cancel flag.
#[derive(Default)]
struct Searches {
    next_id: AtomicU32,
    running: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

/// What a running search sends on its channel: each file with matches, then `done`.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SearchEvent {
    File(search::FileMatches),
    Done(search::SearchSummary),
}

/// Start searching the documents of a folder in the background. Results stream
/// on `on_event`; resolves to an id for `cancel_search`. Rejects at once if the
/// regular expression is invalid.
#[tauri::command]
fn search_folder(
    path: PathBuf,
    query: search::SearchQuery,
    extensions: Vec<String>,
    on_event: Channel<SearchEvent>,
    searches: State<'_, Searches>,
    grants: State<'_, Grants>,
) -> Result<u32, String> {
    granted(&grants, &path)?;
    let compiled = search::Search::new(&query)?;
    let id = searches.next_id.fetch_add(1, Ordering::Relaxed);
    let cancelled = Arc::new(AtomicBool::new(false));
    searches
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, cancelled.clone());
    std::thread::spawn(move || {
        let summary = compiled.run(&path, &extensions, &cancelled, |file| {
            if on_event.send(SearchEvent::File(file)).is_err() {
                cancelled.store(true, Ordering::Relaxed);
            }
        });
        let _ = on_event.send(SearchEvent::Done(summary));
    });
    Ok(id)
}

/// Stop a running search; nothing more is sent for it except `done`.
#[tauri::command]
fn cancel_search(id: u32, searches: State<'_, Searches>) -> Result<(), String> {
    if let Some(cancelled) = searches
        .running
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
    {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Live folder and document watchers, by id. Dropping a watcher stops it.
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
    grants: State<'_, Grants>,
) -> Result<u32, String> {
    granted(&grants, &path)?;
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

/// Watch one document for changes on disk; `on_change` is signalled after each debounced batch.
/// Stop with `unwatch_folder`, which ends any watcher by id.
#[tauri::command]
fn watch_file(
    path: PathBuf,
    on_change: Channel<()>,
    watchers: State<'_, Watchers>,
    grants: State<'_, Grants>,
) -> Result<u32, String> {
    granted(&grants, &path)?;
    let watcher = folder::FolderWatcher::document(&path, move || {
        let _ = on_change.send(());
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

/// The theme folder, created if missing.
#[tauri::command]
fn themes_path(app: AppHandle) -> Result<PathBuf, String> {
    let dir = themes::ensure_dir(&app_data_dir(&app)?).map_err(|e| e.to_string())?;
    let grant = app
        .state::<Grants>()
        .grant_own(&dir, true)
        .map_err(|e| e.to_string())?;
    allow_assets(&app, &grant);
    Ok(dir)
}

/// Where the user's grants are remembered: a folder of its own in the app data
/// directory, which no granted root covers (see [`grants`]).
const GRANTS_FILE: [&str; 2] = ["access", "granted-roots.json"];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // Must come first: a second launch hands its arguments to this one and exits.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = opened::paths_from_args(args.iter().skip(1), std::path::Path::new(&cwd));
            open_from_outside(app, paths);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(Watchers::default())
        .manage(Searches::default())
        .manage(opened::Pending::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            let data_dir = app.path().app_data_dir()?;
            let grants = Grants::load(GRANTS_FILE.iter().fold(data_dir.clone(), |p, n| p.join(n)));
            let path = app.path().app_config_dir()?.join(settings::FILE_NAME);
            // settings.json can be opened as a document from the settings window.
            grants.grant_own(&path, false)?;
            for grant in grants.all() {
                allow_assets(app.handle(), &grant);
            }
            app.manage(grants);
            let handle = app.handle().clone();
            let watcher = settings::watch(path.clone(), move |file| {
                if let Err(e) = handle.emit(SETTINGS_CHANGED, file) {
                    eprintln!("MINT: cannot send the changed settings: {e}");
                }
            })
            .inspect_err(|e| eprintln!("MINT: cannot watch the settings file: {e}"))
            .ok();
            app.manage(SettingsState {
                path,
                _watcher: watcher,
            });
            let recovery_dir = data_dir.join(recovery::DIR_NAME);
            app.manage(recovery::RecoveryArea::open(recovery_dir));
            // `mint notes.md` (Windows and Linux file associations launch MINT this way too).
            let cwd = std::env::current_dir().unwrap_or_default();
            open_from_outside(
                app.handle(),
                opened::paths_from_args(std::env::args().skip(1), &cwd),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            save_asset,
            show_open_dialog,
            show_save_dialog,
            show_open_folder_dialog,
            take_opened_paths,
            settings_path,
            read_settings,
            write_settings,
            updates_supported,
            read_directory,
            create_file,
            create_directory,
            rename_path,
            move_to_trash,
            list_folder_files,
            search_folder,
            cancel_search,
            watch_folder,
            watch_file,
            unwatch_folder,
            read_app_data,
            write_app_data,
            take_recovery_snapshots,
            write_recovery_snapshot,
            delete_recovery_snapshot,
            themes_path
        ])
        .build(tauri::generate_context!())
        .expect("error while building MINT");
    app.run(|handle, event| {
        // macOS opens documents (Finder double-click, "Open With") through an event, not arguments.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .collect();
            open_from_outside(handle, paths);
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        let _ = (handle, event);
    });
}
