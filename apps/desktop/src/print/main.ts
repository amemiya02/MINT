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
  void show(event.payload).then(() => window.print());
});
await emit(printEvents.ready, current.label);

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
