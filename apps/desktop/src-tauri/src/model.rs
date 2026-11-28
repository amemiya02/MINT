//! Send an OpenAI-compatible request from a document window using the system TLS
//! configuration. The renderer owns the message format and reply interpretation.
use reqwest::header::{HeaderValue, CONTENT_TYPE};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::WebviewWindow;

const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelRequest {
    url: String,
    api_key: Option<String>,
    body: Completion,
}

#[derive(Deserialize, Serialize)]
struct Completion {
    model: String,
    messages: Vec<Message>,
    stream: bool,
}

#[derive(Deserialize)]
pub(crate) struct ConnectedCompletion {
    messages: Vec<Message>,
    stream: bool,
}

#[derive(Deserialize, Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ModelEvent {
    Headers { content_type: String },
    Data { bytes: Vec<u8> },
    Done,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum ModelError {
    Status(u16),
    Request(&'static str),
}

fn network_error(error: reqwest::Error) -> ModelError {
    ModelError::Request(if error.is_timeout() {
        "timeout"
    } else {
        "network"
    })
}

pub(crate) fn require_document_window(window: &WebviewWindow) -> Result<(), ModelError> {
    if window.label() != "main" && !window.label().starts_with("window-") {
        return Err(ModelError::Request("denied"));
    }
    Ok(())
}

/// Enforce the same recipient rules for trials and connected requests,
/// including HTTPS except on loopback.
fn service_url(address: &str) -> Result<Url, ModelError> {
    let url = Url::parse(address.trim()).map_err(|_| ModelError::Request("invalidAddress"))?;
    let host = url.host_str().unwrap_or_default();
    if !(url.scheme() == "https" || url.scheme() == "http" && is_loopback(host))
        || host.is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ModelError::Request("invalidAddress"));
    }
    Ok(url)
}

pub(crate) fn completion_url(address: &str) -> Result<Url, ModelError> {
    let mut url = service_url(address)?;
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/chat/completions") {
        path.to_owned()
    } else {
        format!("{path}/chat/completions")
    };
    url.set_path(&path);
    Ok(url)
}

fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

#[tauri::command]
pub(crate) async fn send_model_request(
    window: WebviewWindow,
    request: ModelRequest,
    on_event: Channel<ModelEvent>,
) -> Result<(), ModelError> {
    require_document_window(&window)?;
    let url = service_url(&request.url)?;
    if !url.path().ends_with("/chat/completions") {
        return Err(ModelError::Request("invalidAddress"));
    }
    send(url, request.api_key, request.body, on_event).await
}

#[tauri::command]
pub(crate) async fn send_connected_model_request(
    window: WebviewWindow,
    connection_id: String,
    body: ConnectedCompletion,
    on_event: Channel<ModelEvent>,
) -> Result<(), ModelError> {
    let (endpoint, model, key) = crate::model_connections::with_connections(window, move |store| {
        store.resolve(&connection_id)
    })
    .await?;
    let body = Completion {
        model,
        messages: body.messages,
        stream: body.stream,
    };
    send(endpoint, key, body, on_event).await
}

async fn send(
    url: Url,
    api_key: Option<String>,
    completion: Completion,
    on_event: Channel<ModelEvent>,
) -> Result<(), ModelError> {
    let mut client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120));
    if url.host_str().is_some_and(is_loopback) {
        client = client.no_proxy();
    }
    let body =
        serde_json::to_vec(&completion).map_err(|_| ModelError::Request("invalidRequest"))?;
    let mut post = client
        .build()
        .map_err(network_error)?
        .post(url)
        .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .body(body);
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        // Bearer authorization is attached for this one request only.
        post = post.bearer_auth(key);
    }
    let mut response = post.send().await.map_err(network_error)?;
    if !response.status().is_success() {
        return Err(ModelError::Status(response.status().as_u16()));
    }
    let send = |event| {
        on_event
            .send(event)
            .map_err(|_| ModelError::Request("network"))
    };
    send(ModelEvent::Headers {
        content_type: response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned(),
    })?;
    let mut bytes = 0;
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        bytes += chunk.len();
        if bytes > RESPONSE_LIMIT {
            return Err(ModelError::Request("invalidReply"));
        }
        send(ModelEvent::Data {
            bytes: chunk.to_vec(),
        })?;
    }
    send(ModelEvent::Done)
}
