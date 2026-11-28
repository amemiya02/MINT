//! Cancellation is scoped to each authorized document window and running request.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::WebviewWindow;

type Cancel = Box<dyn Fn() + Send>;
type Requests = HashMap<(String, String), Cancel>;
static REQUESTS: LazyLock<Mutex<Requests>> = LazyLock::new(Mutex::default);

pub(crate) struct Registration((String, String));

impl Registration {
    pub(crate) fn start(
        window: &WebviewWindow,
        id: String,
        cancel: impl Fn() + Send + 'static,
    ) -> Result<Self, &'static str> {
        let key = (window.label().to_owned(), id);
        let mut requests = REQUESTS.lock().map_err(|_| "invalidRequest")?;
        if requests.contains_key(&key) {
            return Err("invalidRequest");
        }
        requests.insert(key.clone(), Box::new(cancel));
        Ok(Self(key))
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut requests) = REQUESTS.lock() {
            requests.remove(&self.0);
        }
    }
}

#[tauri::command]
pub(crate) fn stop_writing_request(window: WebviewWindow, request_id: String) {
    let key = (window.label().to_owned(), request_id);
    if let Ok(requests) = REQUESTS.lock() {
        if let Some(cancel) = requests.get(&key) {
            cancel();
        }
    }
}

pub(crate) fn cancel_window_requests(label: &str) {
    if let Ok(mut requests) = REQUESTS.lock() {
        requests.retain(|(window, _), cancel| {
            if window != label {
                return true;
            }
            cancel();
            false
        });
    }
}
