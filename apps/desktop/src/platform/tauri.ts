import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  type PredefinedMenuItemOptions,
  Submenu,
} from "@tauri-apps/api/menu";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message, open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type {
  DirectoryEntry,
  FileMatches,
  MenuItemSpec,
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

/** Platform implementation for the desktop app: Tauri IPC to the Rust backend. */
export function createTauriPlatform(): Platform {
  return {
    locale: navigator.language,
    readTextFile: (path) => invoke<string>("read_text_file", { path }),
    writeTextFile: (path, text) => invoke<void>("write_text_file", { path, text }),
    async watchFile(path, onChange) {
      const channel = new Channel<null>();
      channel.onmessage = () => onChange();
      const id = await invoke<number>("watch_file", { path, onChange: channel });
      return () => void invoke<void>("unwatch_folder", { id });
    },
    async showOpenDialog({ title, filters }) {
      const picked = await open({
        title,
        multiple: false,
        directory: false,
        filters: filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
      });
      return picked ?? null;
    },
    async showOpenFolderDialog({ title }) {
      return (await open({ title, multiple: false, directory: true })) ?? null;
    },
    readDirectory: (path) => invoke<DirectoryEntry[]>("read_directory", { path }),
    listFolderFiles: (path, extensions) =>
      invoke<string[]>("list_folder_files", { path, extensions }),
    async searchFolder(path, query, extensions, listener) {
      const channel = new Channel<SearchEvent>();
      let cancelled = false;
      channel.onmessage = (event) => {
        if (cancelled) return;
        if (event.kind === "file") listener.onFile({ path: event.path, lines: event.lines });
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
    // The asset protocol's scope is `**` (tauri.conf.json): documents may reference images
    // anywhere, and the page can already read any file through `read_text_file`.
    assetUrl: (path) => convertFileSrc(path),
    createFile: (path) => invoke<void>("create_file", { path }),
    createDirectory: (path) => invoke<void>("create_directory", { path }),
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
        // macOS has one menu bar for the whole app: it must belong to the focused window.
        if (await getCurrentWindow().isFocused()) await windowMenu.setAsAppMenu();
        ensureMenuFollowsFocus();
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
