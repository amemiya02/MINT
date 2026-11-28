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
    #[serde(default)]
    creators: Vec<Creator>,
    date: Option<String>,
    publication_title: Option<String>,
    book_title: Option<String>,
    proceedings_title: Option<String>,
    website_title: Option<String>,
    publisher: Option<String>,
    #[serde(rename = "DOI")]
    doi: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Creator {
    name: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct Citation {
    key: String,
    title: String,
    creators: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    publication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    doi: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct Page {
    items: Vec<Citation>,
    next: bool,
}

fn bibliographic_field(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()).then_some(normalized)
}

/// Accept only a page offset and an author-entered query. Never follow a service
/// redirect or make anything other than a GET to the loopback personal library.
#[tauri::command]
pub(crate) async fn list_zotero_items(
    window: tauri::WebviewWindow,
    start: u32,
    query: Option<String>,
) -> Result<Page, String> {
    if window.label() != "main" && !window.label().starts_with("window-") {
        return Err("denied".into());
    }
    let query = query.as_deref().unwrap_or_default().trim();
    if query.encode_utf16().count() > 200 || query.chars().any(char::is_control) {
        return Err("invalid query".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client
        .get("http://127.0.0.1:23119/api/users/0/items/top")
        .query(&[
            ("v", "3"),
            ("limit", "51"),
            ("sort", "title"),
            ("direction", "asc"),
            ("start", &start.to_string()),
        ]);
    if !query.is_empty() {
        request = request.query(&[("q", query), ("qmode", "titleCreatorYear")]);
    }
    let mut response = request.send().await.map_err(|e| e.to_string())?;
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
            let title = bibliographic_field(row.data.title.as_deref()?)?;
            let creators = row
                .data
                .creators
                .into_iter()
                .filter_map(|creator| {
                    if let Some(name) = creator.name.as_deref().and_then(bibliographic_field) {
                        return Some(name);
                    }
                    bibliographic_field(&format!(
                        "{} {}",
                        creator.first_name.unwrap_or_default(),
                        creator.last_name.unwrap_or_default()
                    ))
                })
                .collect();
            let publication = [
                row.data.publication_title,
                row.data.book_title,
                row.data.proceedings_title,
                row.data.website_title,
                row.data.publisher,
            ]
            .into_iter()
            .flatten()
            .find_map(|field| bibliographic_field(&field));
            Some(Citation {
                key: row.key,
                title,
                creators,
                date: row.data.date.as_deref().and_then(bibliographic_field),
                publication,
                doi: row.data.doi.as_deref().and_then(bibliographic_field),
            })
        })
        .collect();
    Ok(Page { items, next })
}
