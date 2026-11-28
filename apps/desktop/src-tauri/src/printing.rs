//! A print window has already arranged every page, including its margins.
//! Pass its physical sheet to the system dialog, which otherwise starts from
//! the default printer's paper even when the web document declares @page size.
#[cfg(windows)]
mod windows;

use serde::Deserialize;
use tauri::WebviewWindow;

#[derive(Clone, Copy, Deserialize)]
pub(crate) enum Paper {
    A4,
    A5,
    Letter,
}

#[cfg(any(windows, target_os = "macos"))]
impl Paper {
    fn millimetres(self) -> (f64, f64) {
        match self {
            Paper::A4 => (210.0, 297.0),
            Paper::A5 => (148.0, 210.0),
            Paper::Letter => (215.9, 279.4),
        }
    }
}

#[cfg(windows)]
#[tauri::command]
pub(crate) async fn print_pages(
    window: WebviewWindow,
    paper: Paper,
    target: std::path::PathBuf,
) -> Result<(), String> {
    check_window(&window)?;
    windows::save(window, paper, target).await
}

#[cfg(not(windows))]
#[tauri::command]
pub(crate) fn print_pages(window: WebviewWindow, paper: Paper) -> Result<(), String> {
    check_window(&window)?;
    print(&window, paper).map_err(|error| error.to_string())
}

fn check_window(window: &WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("print-") {
        return Err("A print window is required".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn print(window: &WebviewWindow, paper: Paper) -> tauri::Result<()> {
    use objc2_app_kit::{NSPrintInfo, NSWindow};
    use objc2_foundation::{NSCopying, NSSize};
    use objc2_web_kit::WKWebView;

    let (width, height) = paper.millimetres();
    // with_webview runs on the native main thread and keeps both views alive
    // throughout the callback. The print operation retains its job settings.
    window.with_webview(move |view| unsafe {
        let webview = &*view.inner().cast::<WKWebView>();
        let parent = &*view.ns_window().cast::<NSWindow>();
        let info = NSPrintInfo::sharedPrintInfo().copy();
        info.setPaperSize(NSSize::new(width * 72.0 / 25.4, height * 72.0 / 25.4));
        info.setTopMargin(0.0);
        info.setLeftMargin(0.0);
        info.setRightMargin(0.0);
        info.setBottomMargin(0.0);
        let operation = webview.printOperationWithPrintInfo(&info);
        operation.setCanSpawnSeparateThread(true);
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            parent,
            None,
            None,
            std::ptr::null_mut(),
        );
    })
}

#[cfg(target_os = "linux")]
fn print(window: &WebviewWindow, paper: Paper) -> tauri::Result<()> {
    use webkit2gtk::{PrintOperation, PrintOperationExt, PrintOperationResponse};
    let target = window.clone();
    window.with_webview(move |view| {
        let parent = target.gtk_window().ok();
        let size = gtk::PaperSize::new(Some(match paper {
            Paper::A4 => "iso_a4",
            Paper::A5 => "iso_a5",
            Paper::Letter => "na_letter",
        }));
        let setup = gtk::PageSetup::new();
        setup.set_paper_size(&size);
        setup.set_top_margin(0.0, gtk::Unit::Mm);
        setup.set_left_margin(0.0, gtk::Unit::Mm);
        setup.set_right_margin(0.0, gtk::Unit::Mm);
        setup.set_bottom_margin(0.0, gtk::Unit::Mm);
        let settings = gtk::PrintSettings::new();
        settings.set_paper_size(&size);
        let job = PrintOperation::new(&view.inner());
        job.set_page_setup(&setup);
        job.set_print_settings(&settings);
        let finished = target.clone();
        job.connect_finished(move |_| {
            let _ = finished.close();
        });
        if job.run_dialog(parent.as_ref()) == PrintOperationResponse::Cancel {
            let _ = target.close();
        }
    })
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn print(window: &WebviewWindow, _paper: Paper) -> tauri::Result<()> {
    window.print()
}
