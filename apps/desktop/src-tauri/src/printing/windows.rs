//! WebView2's browser print dialog cannot be seeded with the document's paper
//! settings. Its PrintToPdf API accepts physical dimensions for this one job.
use super::Paper;
use std::path::{Path, PathBuf};
use tauri::{Manager, WebviewWindow};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7},
    PrintToPdfCompletedHandler,
};
use windows_core::{Interface, HSTRING};

pub(super) async fn save(
    window: WebviewWindow,
    paper: Paper,
    target: PathBuf,
) -> Result<(), String> {
    crate::granted(&window.state::<crate::Grants>(), &target)?;
    let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
    let path = temp.path().join("print.pdf");
    let output = path.clone();
    let (send, mut receive) = tauri::async_runtime::channel(1);
    window
        .with_webview(move |view| {
            let started = start_print(view, paper, &output, send.clone());
            if let Err(error) = started {
                let _ = send.try_send(Err(error.to_string()));
            }
        })
        .map_err(|error| error.to_string())?;
    receive
        .recv()
        .await
        .ok_or("The PDF print window was closed")??;

    // Publish only a complete job and retain the ordinary save path's atomic
    // replacement and permissions. The private staging directory drops on all exits.
    crate::blocking(move || {
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        crate::granted(&window.state::<crate::Grants>(), &target)?;
        crate::fs::write_atomic(&target, &bytes).map_err(|error| error.to_string())
    })
    .await
}

fn start_print(
    view: tauri::webview::PlatformWebview,
    paper: Paper,
    output: &Path,
    completed: tauri::async_runtime::Sender<Result<(), String>>,
) -> windows_core::Result<()> {
    let (width, height) = paper.millimetres();
    // Tauri calls this closure on WebView2's owning UI thread. Only the job
    // result crosses to the async command, never the COM interfaces.
    unsafe {
        let webview: ICoreWebView2_7 = view.controller().CoreWebView2()?.cast()?;
        let environment: ICoreWebView2Environment6 = view.environment().cast()?;
        let settings = environment.CreatePrintSettings()?;
        settings.SetPageWidth(width / 25.4)?;
        settings.SetPageHeight(height / 25.4)?;
        settings.SetMarginTop(0.0)?;
        settings.SetMarginBottom(0.0)?;
        settings.SetMarginLeft(0.0)?;
        settings.SetMarginRight(0.0)?;
        settings.SetShouldPrintHeaderAndFooter(false)?;
        settings.SetShouldPrintBackgrounds(true)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |status, ok| {
            let result = status.map_err(|error| error.to_string()).and_then(|()| {
                if ok {
                    Ok(())
                } else {
                    Err("WebView2 could not create the PDF".into())
                }
            });
            let _ = completed.try_send(result);
            Ok(())
        }));
        webview.PrintToPdf(&HSTRING::from(output.as_os_str()), &settings, &handler)
    }
}
