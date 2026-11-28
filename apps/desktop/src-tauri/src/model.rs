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

#[tauri::command]
pub(crate) async fn send_model_request(
    window: WebviewWindow,
    request: ModelRequest,
    on_event: Channel<ModelEvent>,
) -> Result<(), ModelError> {
    if window.label() != "main" && !window.label().starts_with("window-") {
        return Err(ModelError::Request("denied"));
    }
    let url = Url::parse(&request.url).map_err(|_| ModelError::Request("invalidAddress"))?;
    let host = url.host_str().unwrap_or_default();
    let loopback = host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || host.is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url.path().ends_with("/chat/completions")
    {
        return Err(ModelError::Request("invalidAddress"));
    }

    let mut client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120));
    if loopback {
        client = client.no_proxy();
    }
    let body =
        serde_json::to_vec(&request.body).map_err(|_| ModelError::Request("invalidRequest"))?;
    let mut post = client
        .build()
        .map_err(network_error)?
        .post(url)
        .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .body(body);
    if let Some(key) = request.api_key.filter(|key| !key.is_empty()) {
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
