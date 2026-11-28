//! Native Streamable HTTP transport for a task's explicitly selected MCP endpoint.
use crate::model::{require_document_window, service_url};
use reqwest::{header, Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const MAX_BODY: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpRequest {
    endpoint: String,
    method: McpMethod,
    body: Option<Value>,
    response_id: Option<u32>,
    session: Option<String>,
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum McpMethod {
    Post,
    Delete,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpResponse {
    body: String,
    content_type: Option<String>,
    session: Option<String>,
}

#[tauri::command]
pub(crate) async fn send_mcp_request(
    window: tauri::WebviewWindow,
    request: McpRequest,
) -> Result<McpResponse, &'static str> {
    require_document_window(&window).map_err(|_| "denied")?;
    let url = service_url(&request.endpoint).map_err(|_| "invalidAddress")?;
    if url.query().is_some() {
        return Err("invalidAddress");
    }
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "mcpFailed")?;
    let method = match request.method {
        McpMethod::Post => Method::POST,
        McpMethod::Delete => Method::DELETE,
    };
    let mut outbound = client
        .request(method, url)
        .header(header::ACCEPT, "application/json, text/event-stream");
    if let Some(session) = request.session {
        outbound = outbound.header("mcp-session-id", session);
    }
    if let Some(version) = request.version {
        outbound = outbound.header("mcp-protocol-version", version);
    }
    if let Some(body) = request.body {
        let bytes = serde_json::to_vec(&body).map_err(|_| "mcpFailed")?;
        if bytes.len() > MAX_BODY {
            return Err("mcpFailed");
        }
        outbound = outbound
            .header(header::CONTENT_TYPE, "application/json")
            .body(bytes);
    }
    let mut response = outbound.send().await.map_err(|_| "mcpFailed")?;
    if !response.status().is_success() {
        return Err("mcpFailed");
    }
    let get_header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let content_type = get_header("content-type");
    let session = get_header("mcp-session-id");
    let mut body = Vec::new();
    if let Some(id) = request.response_id {
        let streaming = content_type.as_deref().is_some_and(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("text/event-stream")
        });
        let mut lines = 0;
        let mut event = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "mcpFailed")? {
            if body.len() + chunk.len() > MAX_BODY {
                return Err("mcpFailed");
            }
            body.extend_from_slice(&chunk);
            if streaming {
                if let Some(end) = response_event_end(&body, &mut lines, &mut event, id) {
                    body.truncate(end);
                    break;
                }
            }
        }
    }
    Ok(McpResponse {
        body: String::from_utf8(body).map_err(|_| "mcpFailed")?,
        content_type,
        session,
    })
}

// POST event streams may remain open. Stop reading after the matching JSON-RPC response,
// and ignore unsolicited messages and heartbeat events.
fn response_event_end(
    body: &[u8],
    scanned: &mut usize,
    event: &mut Vec<u8>,
    id: u32,
) -> Option<usize> {
    while let Some(newline) = body[*scanned..].iter().position(|byte| *byte == b'\n') {
        let line = &body[*scanned..*scanned + newline];
        *scanned += newline + 1;
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            if !event.is_empty()
                && serde_json::from_slice::<Value>(event).is_ok_and(|value| {
                    value["jsonrpc"] == "2.0" && value["id"].as_u64() == Some(u64::from(id))
                })
            {
                return Some(*scanned);
            }
            event.clear();
        } else if let Some(data) = line.strip_prefix(b"data:") {
            event.extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
            event.push(b'\n');
        }
    }
    None
}
