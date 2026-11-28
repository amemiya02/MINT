import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  type PredefinedMenuItemOptions,
  Submenu,
} from "@tauri-apps/api/menu";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { createModelSender, type ModelResponseEvent } from "../ai/model.ts";
import type { WritingReply } from "../ai/writing-sender.ts";
import { type PrintJob, printEvents } from "../print/protocol.ts";
import { pickBrowserFile } from "./pick-file.ts";
import type {
  DirectoryEntry,
  FileMatches,
  MenuItemSpec,
  OpenedPath,
  Platform,
  RecoverySnapshot,
  SettingsFile,
} from "./platform.ts";

/** What the backend's `search_folder` sends on its channel. */
type SearchEvent =
  | ({ readonly kind: "file" } & FileMatches)
  | { readonly kind: "done"; readonly truncated: boolean };

const nativeItems = {
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "SelectAll",
  quit: "Quit",
} as const satisfies Record<string, PredefinedMenuItemOptions["item"]>;

type NativeModelEvent =
  | { readonly kind: "started" }
  | Exclude<ModelResponseEvent, { kind: "data" | "done" }>
  | { readonly kind: "done"; readonly error: number | string | null }
  | { readonly kind: "data"; readonly bytes: number[] };

function writingCancellation(signal?: AbortSignal) {
  const requestId = signal ? crypto.randomUUID() : undefined;
  let started = false;
  function stop() {
    if (started && requestId) void invoke("stop_writing_request", { requestId }).catch(() => {});
  }
  signal?.addEventListener("abort", stop, { once: true });
  return {
    requestId,
    started() {
      started = true;
      if (signal?.aborted) stop();
    },
    dispose() {
      signal?.removeEventListener("abort", stop);
    },
  };
}

const sendTauriModelMessage = createModelSender(async (request, receive, signal) => {
  if (signal?.aborted) throw "stopped";
  const cancellation = writingCancellation(signal);
  let finish: (error: number | string | null) => void = () => {};
  const completed = new Promise<number | string | null>((resolve) => {
    finish = resolve;
  });
  const onEvent = new Channel<NativeModelEvent>((event) => {
    if (event.kind === "started") {
      cancellation.started();
      return;
    }
    receive(event.kind === "data" ? { ...event, bytes: Uint8Array.from(event.bytes) } : event);
    if (event.kind === "done") finish(event.error);
  });
  try {
    const { requestId } = cancellation;
    if ("connectionId" in request) {
      await invoke<void>("send_connected_model_request", { ...request, onEvent, requestId });
    } else {
      await invoke<void>("send_model_request", { request, onEvent, requestId });
    }
    // The invoke result can arrive before the ordered channel's last chunk.
    const error = await completed;
    if (error !== null) throw error;
  } finally {
    cancellation.dispose();
    onEvent.onmessage = () => {};
  }
});

/** Platform implementation for the desktop app: Tauri IPC to the Rust backend. */
export function createTauriPlatform(): Platform {
  return {
    locale: navigator.language,
    writingTasks: {
      list: (path, all) => invoke("list_writing_tasks", { path, all }),
      create: (task) => invoke("create_writing_task", { task }),
      update: (task, expectedUpdatedAt) =>
        invoke("update_writing_task", { task, expectedUpdatedAt }),
      remove: (id) => invoke("delete_writing_task", { id }),
      createTemporary: (id) => invoke("create_temporary_writing_task", { id }),
      removeTemporary: (id) => invoke("delete_temporary_writing_task", { id }),
    },
    externalAgent: {
      discover: () => invoke("discover_external_agents"),
      saved: () => invoke("saved_external_agents"),
      inspect: (path) => invoke("inspect_external_agent", { path }),
      approve: ({ path, revision }, access) =>
        invoke("approve_external_agent", { path, revision, access }),
      forget: (path) => invoke("forget_external_agent", { path }),
      async send({ path, revision }, access, request, options) {
        const args = { path, revision, access, request, taskId: options?.taskId };
        if (!options?.signal && !options?.onDelta) return invoke("send_external_agent", args);
        if (options.signal?.aborted) throw "stopped";
        const cancellation = writingCancellation(options.signal);
        type AgentEvent =
          | { kind: "started" }
          | { kind: "text"; text: string }
          | { kind: "done"; reply: WritingReply | null; error: string | null };
        let finish: (result: Extract<AgentEvent, { kind: "done" }>) => void = () => {};
        const completed = new Promise<Extract<AgentEvent, { kind: "done" }>>((resolve) => {
          finish = resolve;
        });
        const onEvent = new Channel<AgentEvent>((event) => {
          if (event.kind === "started") cancellation.started();
          else if (event.kind === "done") finish(event);
          else if (!options.signal?.aborted) options.onDelta?.(event.text);
        });
        try {
          await invoke("send_external_agent", {
            ...args,
            onEvent,
            requestId: cancellation.requestId,
          });
          const { error, reply } = await completed;
          if (error || !reply) throw error ?? "agentFailed";
          return reply;
        } finally {
          cancellation.dispose();
          onEvent.onmessage = () => {};
        }
      },
    },
    sendModelMessage: sendTauriModelMessage,
    listModelConnections: () => invoke("list_model_connections"),
    saveModelConnection: (connection) => invoke("save_model_connection", { connection }),
    disconnectModelConnection: (id) => invoke("disconnect_model_connection", { id }),
    listZoteroItems: (start) => invoke("list_zotero_items", { start }),
    savesPdfDirectly: /Windows/.test(navigator.userAgent),
    readTextFile: (path) => invoke<string>("read_text_file", { path }),
    readBinaryFile: (path) => invoke<ArrayBuffer>("read_binary_file", { path }),
    writeBinaryFile: (path, bytes) =>
      invoke<void>("write_binary_file", { path, data: toBase64(bytes) }),
    writeTextFile: (path, text) => invoke<void>("write_text_file", { path, text }),
    recordVersion: (path, text) => invoke<void>("record_version", { path, text }),
    listVersions: (path) => invoke<number[]>("list_versions", { path }),
    readVersion: (path, id) => invoke<string>("read_version", { path, id }),
    readAnnotations: (path) => invoke("read_annotations", { path }),
    updateAnnotations: (path, changes) => invoke<void>("update_annotations", { path, changes }),
    async watchFile(path, onChange) {
      const channel = new Channel<null>();
      channel.onmessage = () => onChange();
      const id = await invoke<number>("watch_file", { path, onChange: channel });
      return () => void invoke<void>("unwatch_folder", { id });
    },
    pickFile: pickBrowserFile,
    // A document dialog grants the directory of the file the user chooses.
    showOpenDialog: ({ title, filters }) =>
      invoke<string | null>("show_open_dialog", { title, filters }),
    showSaveDialog: ({ title, defaultPath, filters, knownPaths = [] }) =>
      invoke<string | null>("show_save_dialog", { title, defaultPath, filters, knownPaths }),
    async printDocument(html, options) {
      // A window of its own shows the document and opens the print dialog on it (src/print/main.ts).
      const label = `print-${crypto.randomUUID()}`;
      const { title } = options;
      const job: PrintJob = { html, ...options };
      let deliver = (_sent: Promise<void>) => {};
      const delivered = new Promise<void>((resolve) => {
        deliver = resolve;
      });
      const stop = await listen<string>(printEvents.ready, (event) => {
        if (event.payload !== label) return;
        stop();
        deliver(emitTo(label, printEvents.document, job));
      });
      const window = new WebviewWindow(label, {
        url: "/print.html",
        title,
        width: 860,
        height: 900,
      });
      try {
        await new Promise<void>((resolve, reject) => {
          void window.once("tauri://created", () => resolve());
          void window.once("tauri://error", (e) => reject(new Error(String(e.payload))));
        });
      } catch (e) {
        stop();
        throw e;
      }
      await delivered;
    },
    showOpenFolderDialog: ({ title }) =>
      invoke<string | null>("show_open_folder_dialog", { title }),
    readDirectory: (path) => invoke<DirectoryEntry[]>("read_directory", { path }),
    listFolderFiles: (path, extensions) =>
      invoke<string[]>("list_folder_files", { path, extensions }),
    matchSearchLabels: (query, labels) =>
      invoke<number[]>("match_search_labels", { query, labels }),
    async searchFolder(path, query, extensions, listener) {
      const channel = new Channel<SearchEvent>();
      let cancelled = false;
      channel.onmessage = (event) => {
        if (cancelled) return;
        if (event.kind === "file") listener.onFile(event);
        else listener.onDone({ truncated: event.truncated });
      };
      const id = await invoke<number>("search_folder", {
        path,
        query,
        extensions,
        onEvent: channel,
      });
      return () => {
        cancelled = true;
        void invoke<void>("cancel_search", { id });
      };
    },
    saveAsset: (directory, fileName, data) =>
      invoke<string>("save_asset", { directory, fileName, data: toBase64(data) }),
    // The asset protocol only serves files under granted roots (the backend widens its scope
    // as the user opens documents and folders); other local images fail to load.
    assetUrl: (path) => convertFileSrc(path),
    ensureDocument: (path, initialText) => invoke<void>("ensure_document", { path, initialText }),
    createFile: (path) => invoke<void>("create_file", { path }),
    createDirectory: (path) => invoke<void>("create_directory", { path }),
    applyDocumentEdit: (edit) => invoke<void>("apply_document_edit", { ...edit }),
    rename: (from, to) => invoke<void>("rename_path", { from, to }),
    moveToTrash: (path) => invoke<void>("move_to_trash", { path }),
    async watchFolder(path, onChange) {
      const channel = new Channel<string[]>();
      channel.onmessage = onChange;
      const id = await invoke<number>("watch_folder", { path, onChange: channel });
      return () => void invoke<void>("unwatch_folder", { id });
    },
    readAppData: (name) => invoke<string | null>("read_app_data", { name }),
    writeAppData: (name, text) => invoke<void>("write_app_data", { name, text }),
    // Rejects when the clipboard cannot be read, or holds no text (an image, say).
    readClipboardText: () => readText(),
    writeClipboardText: (text) => writeText(text),
    openExternal: (url) => openUrl(url),
    themesPath: () => invoke<string>("themes_path"),
    async showQuestionDialog({ title, message: text, yes, no, cancel }) {
      const answer = await message(text, {
        title,
        kind: "warning",
        buttons: { yes, no, cancel },
      });
      // Custom buttons answer with their label on some platforms, the button kind on others.
      if (answer === yes || answer === "Yes") return "yes";
      if (answer === no || answer === "No") return "no";
      return "cancel";
    },
    setWindowTitle: (title) => getCurrentWindow().setTitle(title),
    async setMenu(menu) {
      const submenus = await Promise.all(
        menu.map(async (m) =>
          Submenu.new({ text: m.label, items: await Promise.all(m.items.map(toNativeItem)) }),
        ),
      );
      windowMenu = await Menu.new({ items: submenus });
      if (isMac) {
        ensureMenuFollowsFocus();
        // A lone window owns the app menu even when macOS opens a document in the background.
        if ((await getCurrentWindow().isFocused()) || (await getAllWindows()).length === 1) {
          await windowMenu.setAsAppMenu();
        }
      } else {
        await windowMenu.setAsWindowMenu(getCurrentWindow());
      }
    },
    async openWindow() {
      const window = new WebviewWindow(`window-${crypto.randomUUID()}`, {
        url: "/",
        title: "MINT",
        width: 1000,
        height: 720,
        minWidth: 480,
        minHeight: 320,
        // Let files dropped on the window reach the page (image drops into the editor).
        dragDropEnabled: false,
      });
      await new Promise<void>((resolve, reject) => {
        void window.once("tauri://created", () => resolve());
        void window.once("tauri://error", (e) => reject(new Error(String(e.payload))));
      });
    },
    closeWindow: () => getCurrentWindow().close(),
    onCloseRequested(handler) {
      // Tauri destroys the window after the listener unless it calls preventDefault().
      const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
        if (!(await handler())) event.preventDefault();
      });
      return () => void unlisten.then((stop) => stop());
    },
    settingsPath: () => invoke<string>("settings_path"),
    readSettings: () => invoke<SettingsFile>("read_settings"),
    writeSettings: (values) => invoke<void>("write_settings", { values }),
    onOpenPaths(listener) {
      // Paths wait in the backend until a window takes them, so none is lost before this runs.
      const take = () =>
        void invoke<OpenedPath[]>("take_opened_paths").then((paths) => {
          if (paths.length > 0) listener(paths);
        });
      const unlisten = listen("paths-opened", take);
      take();
      return () => void unlisten.then((stop) => stop());
    },
    onSettingsChanged(listener) {
      const unlisten = listen<SettingsFile>("settings-changed", (event) => listener(event.payload));
      return () => void unlisten.then((stop) => stop());
    },
    takeRecoverySnapshots: () => invoke<RecoverySnapshot[]>("take_recovery_snapshots"),
    writeRecoverySnapshot: (id, contents) =>
      invoke<void>("write_recovery_snapshot", { id, contents }),
    deleteRecoverySnapshot: (id) => invoke<void>("delete_recovery_snapshot", { id }),
    isMainWindow: getCurrentWindow().label === "main",
    async checkForUpdate() {
      // The backend knows whether this build was given an updater key and endpoint.
      if (!(await invoke<boolean>("updates_supported"))) return { status: "unavailable" };
      const update = await check();
      if (!update) return { status: "upToDate" };
      return {
        status: "available",
        update: {
          version: update.version,
          async install() {
            await update.downloadAndInstall();
            await relaunch();
          },
        },
      };
    },
  };
}

const isMac = /Mac/.test(navigator.userAgent);
let windowMenu: Menu | null = null;
let followingFocus = false;

function ensureMenuFollowsFocus() {
  if (followingFocus) return;
  followingFocus = true;
  void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused && windowMenu) void windowMenu.setAsAppMenu();
  });
}

function toNativeItem(item: MenuItemSpec) {
  switch (item.kind) {
    case "command":
      return MenuItem.new({
        id: item.id,
        text: item.label,
        ...(item.accelerator ? { accelerator: item.accelerator } : {}),
        action: () => item.run(),
      });
    case "separator":
      return PredefinedMenuItem.new({ item: "Separator" });
    case "native":
      return PredefinedMenuItem.new({ item: nativeItems[item.action], text: item.label });
  }
}

/** Binary data travels over IPC as base64: far smaller than a JSON array of numbers. */
function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
