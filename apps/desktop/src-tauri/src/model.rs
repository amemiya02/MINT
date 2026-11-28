//! Send an OpenAI-compatible request from a document window using the system TLS
//! configuration. The renderer owns the message format and reply interpretation.
use crate::writing_requests::Registration;
use reqwest::header::{HeaderValue, CONTENT_TYPE};
use reqwest::{Client, StatusCode, Url};
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
    content: MessageContent,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum MessageContent {
    Text(String),
    Parts(Vec<MessagePart>),
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum MessagePart {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ImageUrl {
    url: String,
}

fn validate_images(messages: &[Message]) -> Result<(), ModelError> {
    let mut total = 0;
    for message in messages {
        if let MessageContent::Parts(parts) = &message.content {
            if message.role != "user" || parts.is_empty() {
                return Err(ModelError::Request("invalidRequest"));
            }
            for part in parts {
                let MessagePart::ImageUrl { image_url } = part else {
                    continue;
                };
                let url = &image_url.url;
                total += url.len();
                if url.len() > 4 * 1024 * 1024
                    || total > 12 * 1024 * 1024
                    || !url.starts_with("data:image/png;base64,")
                {
                    return Err(ModelError::Request("invalidRequest"));
                }
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ModelEvent {
    Started,
    Headers { content_type: String },
    Data { bytes: Vec<u8> },
    Done { error: Option<ModelError> },
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
    request_id: Option<String>,
) -> Result<(), ModelError> {
    require_document_window(&window)?;
    let url = service_url(&request.url)?;
    if !url.path().ends_with("/chat/completions") {
        return Err(ModelError::Request("invalidAddress"));
    }
    send_until_stopped(
        window,
        request_id,
        url,
        request.api_key,
        request.body,
        on_event,
    )
    .await
}

#[tauri::command]
pub(crate) async fn send_connected_model_request(
    window: WebviewWindow,
    connection_id: String,
    body: ConnectedCompletion,
    on_event: Channel<ModelEvent>,
    request_id: Option<String>,
) -> Result<(), ModelError> {
    let (endpoint, model, key) =
        crate::model_connections::with_connections(window.clone(), move |store| {
            store.resolve(&connection_id)
        })
        .await?;
    let body = Completion {
        model,
        messages: body.messages,
        stream: body.stream,
    };
    send_until_stopped(window, request_id, endpoint, key, body, on_event).await
}

async fn send_until_stopped(
    window: WebviewWindow,
    request_id: Option<String>,
    url: Url,
    api_key: Option<String>,
    completion: Completion,
    on_event: Channel<ModelEvent>,
) -> Result<(), ModelError> {
    let events = on_event.clone();
    let result = if let Some(id) = request_id {
        let (start, mut ready) = tauri::async_runtime::channel(1);
        let job = tauri::async_runtime::spawn(async move {
            ready.recv().await.ok_or(ModelError::Request("stopped"))?;
            send(url, api_key, completion, events).await
        });
        let abort = job.inner().abort_handle();
        let registration = Registration::start(&window, id, move || abort.abort());
        let _registration = match registration {
            Ok(registration) => registration,
            Err(error) => {
                job.abort();
                return Err(ModelError::Request(error));
            }
        };
        if on_event.send(ModelEvent::Started).is_ok() {
            let _ = start.send(()).await;
        } else {
            job.abort();
        }
        job.await.unwrap_or(Err(ModelError::Request("stopped")))
    } else {
        send(url, api_key, completion, events).await
    };
    // Send failures on the same ordered channel so their preceding deltas are retained.
    on_event
        .send(ModelEvent::Done {
            error: result.err(),
        })
        .map_err(|_| ModelError::Request("network"))
}

async fn send(
    url: Url,
    api_key: Option<String>,
    completion: Completion,
    on_event: Channel<ModelEvent>,
) -> Result<(), ModelError> {
    validate_images(&completion.messages)?;
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
        let status = response.status();
        if status == StatusCode::PAYLOAD_TOO_LARGE
            || status == StatusCode::BAD_REQUEST && rejects_context(&mut response).await
        {
            return Err(ModelError::Request("materialCapacity"));
        }
        return Err(ModelError::Status(status.as_u16()));
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
    Ok(())
}

/// Some compatible services report context-window overflow as a structured HTTP 400.
async fn rejects_context(response: &mut reqwest::Response) -> bool {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if body.len() + chunk.len() > 16 * 1024 {
            return false;
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .is_some_and(|value| {
            value.pointer("/error/code").and_then(|code| code.as_str())
                == Some("context_length_exceeded")
        })
}
