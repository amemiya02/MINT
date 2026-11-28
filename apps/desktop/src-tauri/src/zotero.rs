use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Deserialize)]
struct LibraryItem {
    key: String,
    data: Metadata,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    item_type: String,
    title: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct Citation {
    key: String,
    title: String,
}

#[derive(Serialize)]
pub(crate) struct Page {
    items: Vec<Citation>,
    next: bool,
}

/// The renderer supplies only a page offset. Never send document text or follow
/// a service redirect beyond the read-only, loopback personal-library endpoint.
#[tauri::command]
pub(crate) async fn list_zotero_items(
    window: tauri::WebviewWindow,
    start: u32,
) -> Result<Page, String> {
    if window.label() != "main" && !window.label().starts_with("window-") {
        return Err("denied".into());
    }
    let url = format!("http://127.0.0.1:23119/api/users/0/items/top?v=3&limit=51&sort=title&direction=asc&start={start}");
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("unavailable".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Zotero page is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    let rows: Vec<LibraryItem> = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let next = rows.len() > 50;
    let items = rows
        .into_iter()
        .take(50)
        .filter_map(|row| {
            if matches!(
                row.data.item_type.as_str(),
                "note" | "attachment" | "annotation"
            ) || row.key.len() != 8
                || !row.key.bytes().all(|b| b.is_ascii_alphanumeric())
            {
                return None;
            }
            let title = row
                .data
                .title?
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (!title.is_empty()).then_some(Citation {
                key: row.key,
                title,
            })
        })
        .collect();
    Ok(Page { items, next })
}
