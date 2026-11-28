//! Personal and working-folder writing preferences in private app data.

use crate::{app_data, app_data_dir, blocking};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;

const FILE: &str = "writing-preferences.json";
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WritingPreference {
    topic: String,
    guidance: String,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct StoredWritingPreference {
    key: String,
    folder: Option<String>,
    topic: String,
    guidance: String,
}

#[tauri::command]
pub(crate) async fn save_writing_preference(
    app: AppHandle,
    preference: StoredWritingPreference,
) -> Result<(), String> {
    blocking(move || {
        if preference.key.is_empty()
            || preference.topic.trim().is_empty()
            || preference.guidance.trim().is_empty()
        {
            return Err("invalid writing preference".to_owned());
        }
        let _write = WRITES.lock().map_err(|error| error.to_string())?;
        let directory = app_data_dir(&app)?;
        let mut preferences: Vec<StoredWritingPreference> = app_data::read(&directory, FILE)
            .map_err(|error| error.to_string())?
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or_default();
        preferences.retain(|item| item.key != preference.key || item.folder != preference.folder);
        preferences.push(preference);
        let json = serde_json::to_string(&preferences).map_err(|error| error.to_string())?;
        app_data::write(&directory, FILE, &json).map_err(|error| error.to_string())
    })
    .await
}
