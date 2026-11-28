//! Direct model credentials belong to the OS credential store or to this process.
//! The private registry keeps routing metadata only. A connection id resolves to
//! its saved recipient on the Rust side, so a send cannot redirect a stored key.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, WebviewWindow};
use uuid::Uuid;

use crate::app_data;
use crate::model::{completion_url, require_document_window, ModelError};

const REGISTRY: &str = "connections.json";
const SERVICE: &str = "io.github.amemiya02.mint.model";
const UNAVAILABLE: ModelError = ModelError::Request("connectionsUnavailable");
const CREDENTIAL_STORE: ModelError = ModelError::Request("credentialStoreUnavailable");

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Lifetime {
    Persistent,
    Session,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewConnection {
    name: String,
    address: String,
    model: String,
    api_key: String,
    lifetime: Lifetime,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    id: String,
    name: String,
    address: String,
    key_suffix: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Connection {
    #[serde(flatten)]
    summary: Summary,
    model: String,
}

#[derive(Serialize)]
pub(crate) struct ListedConnection {
    #[serde(flatten)]
    summary: Summary,
    lifetime: Lifetime,
}

struct SessionConnection {
    metadata: Connection,
    key: Option<String>,
}

#[derive(Clone)]
pub(crate) struct Connections {
    directory: PathBuf,
    // Serializes registry changes and credential operations across document windows.
    session: Arc<Mutex<Vec<SessionConnection>>>,
}

impl Connections {
    pub(crate) fn new(data_directory: &Path) -> Self {
        Self {
            directory: data_directory.join("model-connections"),
            session: Arc::default(),
        }
    }

    fn read_registry(&self) -> Result<Vec<Connection>, ModelError> {
        let text = app_data::read(&self.directory, REGISTRY).map_err(|_| UNAVAILABLE)?;
        match text {
            Some(text) => serde_json::from_str(&text).map_err(|_| UNAVAILABLE),
            None => Ok(Vec::new()),
        }
    }

    fn write_registry(&self, entries: &[Connection]) -> Result<(), ModelError> {
        let text = serde_json::to_string(entries).map_err(|_| UNAVAILABLE)?;
        app_data::write(&self.directory, REGISTRY, &text).map_err(|_| UNAVAILABLE)
    }

    fn list(&self) -> Result<Vec<ListedConnection>, ModelError> {
        let session = self.session.lock().map_err(|_| UNAVAILABLE)?;
        let persistent = self
            .read_registry()?
            .into_iter()
            .map(|entry| ListedConnection {
                summary: entry.summary,
                lifetime: Lifetime::Persistent,
            });
        Ok(persistent
            .chain(session.iter().map(|entry| ListedConnection {
                summary: entry.metadata.summary.clone(),
                lifetime: Lifetime::Session,
            }))
            .collect())
    }

    fn save(&self, input: NewConnection) -> Result<ListedConnection, ModelError> {
        let name = input.name.trim();
        let model = input.model.trim();
        if name.is_empty() || model.is_empty() {
            return Err(ModelError::Request("invalidRequest"));
        }
        let address = input.address.trim();
        let endpoint = completion_url(address)?;
        let key = input.api_key.trim();
        if !key.bytes().all(|byte| (b'!'..=b'~').contains(&byte)) {
            return Err(ModelError::Request("invalidKey"));
        }
        let key = (!key.is_empty()).then_some(key);
        let metadata = Connection {
            summary: Summary {
                id: Uuid::new_v4().to_string(),
                name: name.to_owned(),
                address: address.to_owned(),
                // A short token still gets a mask without revealing its entire value.
                key_suffix: key.map(|key| {
                    let from = if key.len() > 4 {
                        key.len() - 4
                    } else {
                        key.len()
                    };
                    key[from..].to_owned()
                }),
            },
            model: model.to_owned(),
        };
        let summary = metadata.summary.clone();
        let mut session = self.session.lock().map_err(|_| UNAVAILABLE)?;
        match input.lifetime {
            Lifetime::Session => session.push(SessionConnection {
                metadata,
                key: key.map(str::to_owned),
            }),
            Lifetime::Persistent => {
                let mut entries = self.read_registry()?;
                let entry = key
                    .map(|_| credential(&summary.id, &endpoint))
                    .transpose()?;
                if let Some((entry, key)) = entry.as_ref().zip(key) {
                    entry.set_password(key).map_err(|_| CREDENTIAL_STORE)?;
                }
                entries.push(metadata);
                if let Err(error) = self.write_registry(&entries) {
                    if let Some(entry) = entry {
                        remove_credential(&entry)?;
                    }
                    return Err(error);
                }
            }
        }
        Ok(ListedConnection {
            summary,
            lifetime: input.lifetime,
        })
    }

    fn disconnect(&self, id: &str) -> Result<(), ModelError> {
        let mut session = self.session.lock().map_err(|_| UNAVAILABLE)?;
        if let Some(index) = session
            .iter()
            .position(|entry| entry.metadata.summary.id == id)
        {
            session.remove(index);
            return Ok(());
        }
        let mut entries = self.read_registry()?;
        let Some(index) = entries.iter().position(|entry| entry.summary.id == id) else {
            return Ok(());
        };
        let entry = entries.remove(index);
        if entry.summary.key_suffix.is_some() {
            let endpoint = completion_url(&entry.summary.address)?;
            remove_credential(&credential(id, &endpoint)?)?;
        }
        // Delete the credential first. A failed metadata write can be retried,
        // and any send from a stale card fails rather than sending anonymously.
        self.write_registry(&entries)
    }

    pub(crate) fn resolve(&self, id: &str) -> Result<(Url, String, Option<String>), ModelError> {
        let session = self.session.lock().map_err(|_| UNAVAILABLE)?;
        if let Some(entry) = session.iter().find(|entry| entry.metadata.summary.id == id) {
            let url = completion_url(&entry.metadata.summary.address)?;
            return Ok((url, entry.metadata.model.clone(), entry.key.clone()));
        }
        let entry = self
            .read_registry()?
            .into_iter()
            .find(|entry| entry.summary.id == id)
            .ok_or(ModelError::Request("connectionMissing"))?;
        let url = completion_url(&entry.summary.address)?;
        let key = if entry.summary.key_suffix.is_some() {
            Some(
                credential(id, &url)?
                    .get_password()
                    .map_err(|error| match error {
                        keyring::Error::NoEntry => ModelError::Request("credentialMissing"),
                        _ => CREDENTIAL_STORE,
                    })?,
            )
        } else {
            None
        };
        Ok((url, entry.model, key))
    }
}

fn credential(id: &str, endpoint: &Url) -> Result<keyring::Entry, ModelError> {
    // Bind the credential to the recipient even if its metadata changes on disk.
    let address_hash = Sha256::digest(endpoint.as_str());
    keyring::Entry::new(SERVICE, &format!("{id}-{address_hash:x}")).map_err(|_| CREDENTIAL_STORE)
}

fn remove_credential(entry: &keyring::Entry) -> Result<(), ModelError> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(CREDENTIAL_STORE),
    }
}

pub(crate) async fn with_connections<T: Send + 'static>(
    window: WebviewWindow,
    work: impl FnOnce(&Connections) -> Result<T, ModelError> + Send + 'static,
) -> Result<T, ModelError> {
    require_document_window(&window)?;
    let connections = window.state::<Connections>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || work(&connections))
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub(crate) async fn list_model_connections(
    window: WebviewWindow,
) -> Result<Vec<ListedConnection>, ModelError> {
    with_connections(window, Connections::list).await
}

#[tauri::command]
pub(crate) async fn save_model_connection(
    window: WebviewWindow,
    connection: NewConnection,
) -> Result<ListedConnection, ModelError> {
    with_connections(window, move |store| store.save(connection)).await
}

#[tauri::command]
pub(crate) async fn disconnect_model_connection(
    window: WebviewWindow,
    id: String,
) -> Result<(), ModelError> {
    with_connections(window, move |store| store.disconnect(&id)).await
}
