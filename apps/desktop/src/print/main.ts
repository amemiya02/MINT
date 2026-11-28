import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type PrintJob, printEvents } from "./protocol.ts";

/**
 * The print window: shows one exported document, then opens the system print
 * dialog on it, where the user saves it as a PDF. It is a window of its own
 * so the document prints exactly as HTML export writes it, without the
 * editor's styles, and because on macOS Tauri prints a webview's whole page.
 */
const current = getCurrentWebviewWindow();
const stop = await current.listen<PrintJob>(printEvents.document, (event) => {
  stop();
  void show(event.payload)
    .then(() => {
      closeAfterPrinting();
      return invoke("print_pages", { paper: event.payload.paper });
    })
    .catch((reason) => {
      const error = document.createElement("p");
      error.setAttribute("role", "alert");
      error.textContent = String(reason);
      document.body.prepend(error);
    });
});
await emit(printEvents.ready, current.label);

/**
 * WebView2 reports completion through afterprint. GTK closes the window from
 * the native print operation. The macOS sheet can outlive afterprint.
 */
function closeAfterPrinting() {
  if (!/Windows/.test(navigator.userAgent)) return;
  window.addEventListener("afterprint", () => void current.close(), { once: true });
}

/** Replace this page with the document, and wait until its fonts and images are in. */
async function show({ html, title }: PrintJob): Promise<void> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.replaceChild(document.adoptNode(parsed.documentElement), document.documentElement);
  // Names the print job, and so the PDF file the print dialog suggests.
  document.title = title;
  // Fonts (KaTeX's) load only once laid-out text needs them: load them all up front.
  await Promise.all([...document.fonts].map((font) => font.load().catch(() => undefined)));
  await document.fonts.ready;
  await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
}
