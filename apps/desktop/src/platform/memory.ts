import type {
  DirectoryEntry,
  MenuItemSpec,
  MenuSpec,
  Platform,
  SettingsFile,
  SettingsValues,
} from "./platform.ts";

/** Where the in-memory platform keeps settings.json (seed it through `files`). */
export const memorySettingsPath = "/config/MINT/settings.json";

export interface MemoryPlatformOptions {
  /** Initial files, keyed by absolute `/`-separated path. Their parent directories exist implicitly. */
  readonly files?: Readonly<Record<string, string>>;
  /** Extra (possibly empty) directories. */
  readonly directories?: readonly string[];
  /** Paths the open dialog returns, in order; `null` simulates cancelling. */
  readonly openDialogResults?: readonly (string | null)[];
  /** Paths the open folder dialog returns, in order; `null` simulates cancelling. */
  readonly openFolderDialogResults?: readonly (string | null)[];
  /** Initial contents of the app data directory, keyed by name. */
  readonly appData?: Readonly<Record<string, string>>;
  /** Answers the question dialog gives, in order; once used up it answers `cancel`. */
  readonly questionDialogResults?: readonly ("yes" | "no" | "cancel")[];
  readonly locale?: string;
}

/** Platform implementation backed by memory, for E2E tests and the future web build. */
export interface MemoryPlatform extends Platform {
  /** Current file contents, keyed by path. */
  readonly files: Map<string, string>;
  /** Paths moved to the trash, in order. */
  readonly trash: string[];
  /** Contents of the app data directory, keyed by name. */
  readonly appData: Map<string, string>;
  readonly windowTitle: string;
  /** Every file and directory path that exists, sorted. */
  listPaths(): string[];
  /** Write a file as another program would (watchers are notified). */
  externalWrite(path: string, text: string): void;
  /** Delete a file or directory as another program would (watchers are notified). */
  externalRemove(path: string): void;
  /** URLs passed to `openExternal`, in order. */
  readonly openedUrls: readonly string[];
  /** Messages of the question dialogs shown so far. */
  readonly questions: readonly string[];
  /** Whether this window has closed. */
  readonly closed: boolean;
  /** Activate a menu item by id, as a click in a native menu would. */
  runMenuItem(id: string): void;
}

export function createMemoryPlatform(options: MemoryPlatformOptions = {}): MemoryPlatform {
  const files = new Map(Object.entries(options.files ?? {}));
  // The config directory always exists, so settings.json can be created from outside.
  const directories = new Set([
    memorySettingsPath.slice(0, memorySettingsPath.lastIndexOf("/")),
    ...(options.directories ?? []),
  ]);
  const appData = new Map(Object.entries(options.appData ?? {}));
  const trash: string[] = [];
  const dialogResults = [...(options.openDialogResults ?? [])];
  const folderDialogResults = [...(options.openFolderDialogResults ?? [])];
  const watchers = new Set<{ root: string; onChange: (paths: readonly string[]) => void }>();
  const questionResults = [...(options.questionDialogResults ?? [])];
  const questions: string[] = [];
  let commands: Extract<MenuItemSpec, { kind: "command" }>[] = [];
  let windowTitle = "";
  const openedUrls: string[] = [];
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

  const isDirectory = (path: string): boolean =>
    directories.has(path) || [...files.keys()].some((f) => f.startsWith(`${path}/`));
  const exists = (path: string): boolean => files.has(path) || isDirectory(path);
  const within = (path: string, root: string): boolean =>
    path === root || path.startsWith(`${root}/`);

  function requireParent(path: string): void {
    const parent = parentOf(path);
    if (parent !== "" && parent !== "/" && !isDirectory(parent)) {
      throw new Error(`No such directory: ${parent}`);
    }
  }

  function notify(...paths: string[]): void {
    for (const watcher of watchers) {
      const touched = paths.filter((p) => within(p, watcher.root));
      // Like a real file watcher, events arrive asynchronously.
      if (touched.length > 0) setTimeout(() => watcher.onChange(touched), 0);
    }
  }

  function remove(path: string): void {
    for (const key of [...files.keys()]) if (within(key, path)) files.delete(key);
    for (const dir of [...directories]) if (within(dir, path)) directories.delete(dir);
  }

  return {
    locale: options.locale ?? navigator.language,
    files,
    trash,
    appData,
    openedUrls,
    get windowTitle() {
      return windowTitle;
    },
    async readTextFile(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`No such file: ${path}`);
      return text;
    },
    async writeTextFile(path, text) {
      requireParent(path);
      files.set(path, text);
      // Mirrors the backend's file watcher: any write to settings.json is reported.
      if (path === memorySettingsPath) notifySettings();
      notify(path);
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
    async showOpenFolderDialog() {
      return folderDialogResults.shift() ?? null;
    },
    async readDirectory(path) {
      if (!isDirectory(path)) throw new Error(`No such directory: ${path}`);
      const children = new Map<string, DirectoryEntry>();
      const prefix = `${path}/`;
      for (const p of [...files.keys(), ...directories]) {
        if (!p.startsWith(prefix)) continue;
        const name = p.slice(prefix.length).split("/")[0] ?? "";
        const child = prefix + name;
        if (!children.has(name)) {
          children.set(name, {
            name,
            path: child,
            kind: files.has(child) ? "file" : "directory",
          });
        }
      }
      return [...children.values()];
    },
    async createFile(path) {
      if (exists(path)) throw new Error(`${path} already exists`);
      requireParent(path);
      files.set(path, "");
      notify(path);
    },
    async createDirectory(path) {
      if (exists(path)) throw new Error(`${path} already exists`);
      requireParent(path);
      directories.add(path);
      notify(path);
    },
    async rename(from, to) {
      if (!exists(from)) throw new Error(`No such file or directory: ${from}`);
      if (exists(to)) throw new Error(`${to} already exists`);
      requireParent(to);
      const move = (p: string) => to + p.slice(from.length);
      for (const [p, text] of [...files]) {
        if (within(p, from)) {
          files.delete(p);
          files.set(move(p), text);
        }
      }
      for (const d of [...directories]) {
        if (within(d, from)) {
          directories.delete(d);
          directories.add(move(d));
        }
      }
      notify(from, to);
    },
    async moveToTrash(path) {
      if (!exists(path)) throw new Error(`No such file or directory: ${path}`);
      remove(path);
      trash.push(path);
      notify(path);
    },
    async watchFolder(root, onChange) {
      const watcher = { root, onChange };
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    async readAppData(name) {
      return appData.get(name) ?? null;
    },
    async writeAppData(name, text) {
      appData.set(name, text);
    },
    async openExternal(url) {
      openedUrls.push(url);
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
    listPaths() {
      const all = new Set([...files.keys(), ...directories]);
      for (const p of [...all]) {
        for (let dir = parentOf(p); dir !== "" && dir !== "/"; dir = parentOf(dir)) all.add(dir);
      }
      return [...all].sort();
    },
    externalWrite(path, text) {
      files.set(path, text);
      notify(path);
    },
    externalRemove(path) {
      remove(path);
      notify(path);
    },
    runMenuItem(id) {
      const command = commands.find((c) => c.id === id);
      if (!command) throw new Error(`No menu item: ${id}`);
      command.run();
    },
  };
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
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
    // With Option held, macOS reports the composed character (⌥F is "ƒ"), so fall back to the physical key.
    (event.key.toLowerCase() === key || event.code.toLowerCase() === `key${key}`) &&
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.shiftKey === mods.has("shift") &&
    event.altKey === (mods.has("alt") || mods.has("option"))
  );
}
