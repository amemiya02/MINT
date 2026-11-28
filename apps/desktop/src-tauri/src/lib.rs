//! MINT's Rust backend. It stays thin (ADR-0005): only what the web layer
//! cannot do well lives here. Each IPC command is a small wrapper over a plain
//! function that is unit-tested with `cargo test`.

mod app_data;
mod assets;
mod document_edit;
mod folder;
mod fs;
mod grants;
mod history;
mod opened;
mod printing;
mod recovery;
mod search;
mod settings;
mod themes;
mod updates;
mod walk;
mod zotero;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use grants::{Grant, Grants};

/// Run blocking work (disk IO, starting a watcher) on a worker thread. Sync
/// commands run on the main thread, so any IO there freezes the window; every
/// command that touches the disk is `async` and goes through this.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

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
async fn read_text_file(app: AppHandle, path: PathBuf) -> Result<String, String> {
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        fs::read_text(&path).map_err(|e| e.to_string())
    })
    .await
}

/// Write a document atomically (temporary file + rename).
#[tauri::command]
async fn write_text_file(app: AppHandle, path: PathBuf, text: String) -> Result<(), String> {
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        fs::write_atomic(&path, text.as_bytes()).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn write_binary_file(app: AppHandle, path: PathBuf, data: String) -> Result<(), String> {
    use base64::Engine as _;
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?;
        fs::write_atomic(&path, &bytes).map_err(|e| e.to_string())
    })
    .await
}

fn history_directory(app: &AppHandle, path: &std::path::Path) -> Result<PathBuf, String> {
    let document = app
        .state::<Grants>()
        .check(path)
        .map_err(|e| e.to_string())?;
    Ok(history::directory(&app_data_dir(app)?, &document))
}

#[tauri::command]
async fn record_version(app: AppHandle, path: PathBuf, text: String) -> Result<(), String> {
    blocking(move || {
        history::record(&history_directory(&app, &path)?, &text).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn list_versions(app: AppHandle, path: PathBuf) -> Result<Vec<u64>, String> {
    blocking(move || history::versions(&history_directory(&app, &path)?).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
async fn read_version(app: AppHandle, path: PathBuf, id: u64) -> Result<String, String> {
    blocking(move || history::read(&history_directory(&app, &path)?, id).map_err(|e| e.to_string()))
        .await
}

/// Save a pasted or dropped asset (base64 `data`) under a name that is not
/// taken yet in `directory`; returns the new file's path.
#[tauri::command]
async fn save_asset(
    app: AppHandle,
    directory: PathBuf,
    file_name: String,
    data: String,
) -> Result<PathBuf, String> {
    use base64::Engine as _;
    blocking(move || {
        granted(&app.state::<Grants>(), &directory)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?;
        assets::save(&directory, &file_name, &bytes).map_err(|e| e.to_string())
    })
    .await
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
async fn read_settings(state: State<'_, SettingsState>) -> Result<settings::SettingsFile, String> {
    let path = state.path.clone();
    blocking(move || Ok(settings::load(&path))).await
}

#[tauri::command]
async fn write_settings(
    state: State<'_, SettingsState>,
    values: Map<String, Value>,
) -> Result<(), String> {
    let path = state.path.clone();
    blocking(move || settings::save(&path, &values).map_err(|e| e.to_string())).await
}

/// Snapshots of unsaved work left by an earlier run; only the first caller gets them.
#[tauri::command]
fn take_recovery_snapshots(area: State<'_, recovery::RecoveryArea>) -> Vec<recovery::Snapshot> {
    area.take_left_over()
}

#[tauri::command]
async fn write_recovery_snapshot(
    app: AppHandle,
    id: String,
    contents: String,
) -> Result<(), String> {
    blocking(move || {
        app.state::<recovery::RecoveryArea>()
            .write(&id, &contents)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn delete_recovery_snapshot(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || {
        app.state::<recovery::RecoveryArea>()
            .remove(&id)
            .map_err(|e| e.to_string())
    })
    .await
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
async fn read_directory(app: AppHandle, path: PathBuf) -> Result<Vec<folder::Entry>, String> {
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        folder::list_dir(&path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn create_file(app: AppHandle, path: PathBuf) -> Result<(), String> {
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        folder::create_file(&path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn create_directory(app: AppHandle, path: PathBuf) -> Result<(), String> {
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        folder::create_dir(&path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn apply_document_edit(
    app: AppHandle,
    from: PathBuf,
    to: PathBuf,
    before: String,
    after: String,
) -> Result<(), String> {
    blocking(move || {
        let grants = app.state::<Grants>();
        granted(&grants, &from)?;
        granted(&grants, &to)?;
        document_edit::apply(&from, &to, before.as_bytes(), after.as_bytes())
            .map_err(|e| format!("{} → {}: {e}", from.display(), to.display()))
    })
    .await
}

#[tauri::command]
async fn rename_path(app: AppHandle, from: PathBuf, to: PathBuf) -> Result<(), String> {
    blocking(move || {
        let grants = app.state::<Grants>();
        granted(&grants, &from)?;
        granted(&grants, &to)?;
        folder::rename(&from, &to).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn move_to_trash(app: AppHandle, path: PathBuf) -> Result<(), String> {
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        folder::move_to_trash(&path).map_err(|e| e.to_string())
    })
    .await
}

/// Every file of a folder, recursively, except entries ignored by `.gitignore`
/// and hidden ones; only those with one of `extensions` unless it is empty.
#[tauri::command]
async fn list_folder_files(
    app: AppHandle,
    path: PathBuf,
    extensions: Vec<String>,
) -> Result<Vec<PathBuf>, String> {
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        Ok(walk::list_files(&path, &extensions))
    })
    .await
}

/// Match the live editor's headings using the same query syntax as the folder search.
#[tauri::command]
async fn match_search_labels(
    query: search::SearchQuery,
    labels: Vec<String>,
) -> Result<Vec<usize>, String> {
    let compiled = search::Search::new(&query)?;
    Ok(labels
        .iter()
        .enumerate()
        .filter_map(|(i, label)| compiled.matches_label(label).then_some(i))
        .collect())
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
async fn search_folder(
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
async fn cancel_search(id: u32, searches: State<'_, Searches>) -> Result<(), String> {
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

impl Watchers {
    /// Keep `watcher` running; returns its id for `unwatch_folder`.
    fn add(&self, watcher: folder::FolderWatcher) -> Result<u32, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.active
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, watcher);
        Ok(id)
    }
}

/// Watch a folder recursively; each debounced batch of changed paths is sent on `on_change`.
#[tauri::command]
async fn watch_folder(
    app: AppHandle,
    path: PathBuf,
    on_change: Channel<Vec<PathBuf>>,
) -> Result<u32, String> {
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        let watcher = folder::FolderWatcher::new(&path, move |paths| {
            let _ = on_change.send(paths);
        })
        .map_err(|e| e.to_string())?;
        app.state::<Watchers>().add(watcher)
    })
    .await
}

/// Watch one document for changes on disk; `on_change` is signalled after each debounced batch.
/// Stop with `unwatch_folder`, which ends any watcher by id.
#[tauri::command]
async fn watch_file(app: AppHandle, path: PathBuf, on_change: Channel<()>) -> Result<u32, String> {
    blocking(move || {
        granted(&app.state::<Grants>(), &path)?;
        let watcher = folder::FolderWatcher::document(&path, move || {
            let _ = on_change.send(());
        })
        .map_err(|e| e.to_string())?;
        app.state::<Watchers>().add(watcher)
    })
    .await
}

#[tauri::command]
async fn unwatch_folder(app: AppHandle, id: u32) -> Result<(), String> {
    // Stopping a platform watcher waits for its thread, so not on the main thread either.
    blocking(move || {
        let watcher = app
            .state::<Watchers>()
            .active
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id);
        drop(watcher);
        Ok(())
    })
    .await
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_app_data(app: AppHandle, name: String) -> Result<Option<String>, String> {
    blocking(move || app_data::read(&app_data_dir(&app)?, &name).map_err(|e| e.to_string())).await
}

#[tauri::command]
async fn write_app_data(app: AppHandle, name: String, text: String) -> Result<(), String> {
    blocking(move || app_data::write(&app_data_dir(&app)?, &name, &text).map_err(|e| e.to_string()))
        .await
}

/// The theme folder, created if missing.
#[tauri::command]
async fn themes_path(app: AppHandle) -> Result<PathBuf, String> {
    blocking(move || {
        let dir = themes::ensure_dir(&app_data_dir(&app)?).map_err(|e| e.to_string())?;
        let grant = app
            .state::<Grants>()
            .grant_own(&dir, true)
            .map_err(|e| e.to_string())?;
        allow_assets(&app, &grant);
        Ok(dir)
    })
    .await
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
            zotero::list_zotero_items,
            printing::print_pages,
            read_text_file,
            write_text_file,
            write_binary_file,
            record_version,
            list_versions,
            read_version,
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
            apply_document_edit,
            move_to_trash,
            list_folder_files,
            search_folder,
            match_search_labels,
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
    // Finder can send Opened before Tauri runs setup and registers the file grants.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let mut startup_paths = Some(Vec::new());
    app.run(move |handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        match event {
            tauri::RunEvent::Opened { urls } => {
                let paths = urls.into_iter().filter_map(|url| url.to_file_path().ok());
                if let Some(pending) = &mut startup_paths {
                    pending.extend(paths);
                } else {
                    open_from_outside(handle, paths.collect());
                }
            }
            tauri::RunEvent::Ready => {
                if let Some(paths) = startup_paths.take() {
                    open_from_outside(handle, paths);
                }
            }
            _ => {}
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        let _ = (handle, event);
    });
}
