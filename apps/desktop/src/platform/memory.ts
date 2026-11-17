import type { MenuItemSpec, MenuSpec, Platform, SettingsFile, SettingsValues } from "./platform.ts";

/** Where the in-memory platform keeps settings.json (seed it through `files`). */
export const memorySettingsPath = "/config/MINT/settings.json";

export interface MemoryPlatformOptions {
  /** Initial files, keyed by path. */
  readonly files?: Readonly<Record<string, string>>;
  /** Paths the open dialog returns, in order; `null` simulates cancelling. */
  readonly openDialogResults?: readonly (string | null)[];
  /** Answers the question dialog gives, in order; once used up it answers `cancel`. */
  readonly questionDialogResults?: readonly ("yes" | "no" | "cancel")[];
  readonly locale?: string;
  /**
   * What the release server answers: a newer version (optionally failing to
   * install), a failing check, or `"unavailable"` for builds that cannot update.
   * Without it MINT is up to date.
   */
  readonly update?:
    | { readonly version: string; readonly installError?: string }
    | { readonly error: string }
    | "unavailable";
}

/** Platform implementation backed by memory, for E2E tests and the future web build. */
export interface MemoryPlatform extends Platform {
  /** Current file contents, keyed by path. */
  readonly files: Map<string, string>;
  readonly windowTitle: string;
  /** Messages of the question dialogs shown so far. */
  readonly questions: readonly string[];
  /** Whether this window has closed. */
  readonly closed: boolean;
  /** Versions installed (and restarted into) so far. */
  readonly updatesInstalled: readonly string[];
  /** Activate a menu item by id, as a click in a native menu would. */
  runMenuItem(id: string): void;
}

export function createMemoryPlatform(options: MemoryPlatformOptions = {}): MemoryPlatform {
  const files = new Map(Object.entries(options.files ?? {}));
  const dialogResults = [...(options.openDialogResults ?? [])];
  const questionResults = [...(options.questionDialogResults ?? [])];
  const questions: string[] = [];
  const updatesInstalled: string[] = [];
  let commands: Extract<MenuItemSpec, { kind: "command" }>[] = [];
  let windowTitle = "";
  let closeHandler: (() => Promise<boolean>) | null = null;
  let closed = false;
  const settingsListeners = new Set<(file: SettingsFile) => void>();

  // Same contract as the Rust backend's `settings::load`.
  function readSettings(): SettingsFile {
    const text = files.get(memorySettingsPath);
    if (text === undefined) return { status: "missing" };
    let values: unknown;
    try {
      values = JSON.parse(text);
    } catch (e) {
      return { status: "invalid", message: e instanceof Error ? e.message : String(e) };
    }
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      return { status: "invalid", message: "the file must contain a JSON object" };
    }
    return { status: "ok", values: values as SettingsValues };
  }

  function notifySettings() {
    const file = readSettings();
    // Watchers report asynchronously, like file system events do.
    setTimeout(() => {
      for (const listener of settingsListeners) listener(file);
    });
  }

  // Without a native menu, accelerators are handled in the page.
  window.addEventListener("keydown", (event) => {
    const command = commands.find((c) => c.accelerator && matchesAccelerator(event, c.accelerator));
    if (!command) return;
    event.preventDefault();
    command.run();
  });

  return {
    locale: options.locale ?? navigator.language,
    files,
    get windowTitle() {
      return windowTitle;
    },
    async readTextFile(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`No such file: ${path}`);
      return text;
    },
    async writeTextFile(path, text) {
      files.set(path, text);
      // Mirrors the backend's file watcher: any write to settings.json is reported.
      if (path === memorySettingsPath) notifySettings();
    },
    get questions() {
      return questions;
    },
    get closed() {
      return closed;
    },
    async showOpenDialog() {
      return dialogResults.shift() ?? null;
    },
    async showQuestionDialog({ message }) {
      questions.push(message);
      return questionResults.shift() ?? "cancel";
    },
    async openWindow() {
      // A browser window running the same shell, with its own in-memory platform.
      window.open(location.href, "_blank");
    },
    async closeWindow() {
      if (closeHandler && !(await closeHandler())) return;
      closed = true;
      window.close();
    },
    onCloseRequested(handler) {
      closeHandler = handler;
      return () => {
        if (closeHandler === handler) closeHandler = null;
      };
    },
    async setWindowTitle(title) {
      windowTitle = title;
      document.title = title;
    },
    async setMenu(menu: readonly MenuSpec[]) {
      commands = menu.flatMap((m) => m.items.filter((i) => i.kind === "command"));
    },
    async settingsPath() {
      return memorySettingsPath;
    },
    async readSettings() {
      return readSettings();
    },
    async writeSettings(values) {
      files.set(memorySettingsPath, `${JSON.stringify(values, null, 2)}\n`);
      notifySettings();
    },
    onSettingsChanged(listener) {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    // A window opened by another one (see `openWindow`) is not the main window.
    isMainWindow: !window.opener,
    get updatesInstalled() {
      return updatesInstalled;
    },
    async checkForUpdate() {
      const update = options.update;
      if (update === undefined) return { status: "upToDate" };
      if (update === "unavailable") return { status: "unavailable" };
      if ("error" in update) throw new Error(update.error);
      return {
        status: "available",
        update: {
          version: update.version,
          async install() {
            if (update.installError) throw new Error(update.installError);
            updatesInstalled.push(update.version);
          },
        },
      };
    },
    runMenuItem(id) {
      const command = commands.find((c) => c.id === id);
      if (!command) throw new Error(`No menu item: ${id}`);
      command.run();
    },
  };
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function matchesAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  const parts = accelerator.split("+");
  const key = parts.pop()?.toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const primary = mods.has("cmdorctrl") || mods.has("commandorcontrol");
  const wantMeta = mods.has("cmd") || mods.has("command") || (primary && isMac);
  const wantCtrl = mods.has("ctrl") || mods.has("control") || (primary && !isMac);
  return (
    event.key.toLowerCase() === key &&
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.shiftKey === mods.has("shift") &&
    event.altKey === (mods.has("alt") || mods.has("option"))
  );
}
