import { createIgnoreRules } from "./gitignore.ts";
import type {
  DirectoryEntry,
  FolderSearchQuery,
  LineMatch,
  MenuItemSpec,
  MenuSpec,
  Platform,
  RecoverySnapshot,
  SettingsFile,
  SettingsValues,
} from "./platform.ts";

/** Where the in-memory platform keeps settings.json (seed it through `files`). */
export const memorySettingsPath = "/config/MINT/settings.json";

/**
 * Where the in-memory platform keeps recovery snapshots, one `<id>.json` file each.
 * Seeding `files` with snapshots here simulates work left behind by a crash.
 */
export const memoryRecoveryDir = "/data/MINT/recovery";

/** The in-memory theme folder (seed user themes through `files`). */
export const memoryThemesPath = "/data/MINT/themes";

export interface MemoryPlatformOptions {
  /** Initial files, keyed by absolute `/`-separated path. Their parent directories exist implicitly. */
  readonly files?: Readonly<Record<string, string>>;
  /** Extra (possibly empty) directories. */
  readonly directories?: readonly string[];
  /** Paths the open dialog returns, in order; `null` simulates cancelling. */
  readonly openDialogResults?: readonly (string | null)[];
  /** Paths the save dialog returns, in order; `null` simulates cancelling. */
  readonly saveDialogResults?: readonly (string | null)[];
  /** Paths the open folder dialog returns, in order; `null` simulates cancelling. */
  readonly openFolderDialogResults?: readonly (string | null)[];
  /** Initial binary files (images...), keyed by absolute path, as base64. */
  readonly binaryFiles?: Readonly<Record<string, string>>;
  /** Initial contents of the app data directory, keyed by name. */
  readonly appData?: Readonly<Record<string, string>>;
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
  /** Current text file contents, keyed by path. */
  readonly files: Map<string, string>;
  /** Current binary file contents (assets such as images), keyed by path. */
  readonly binaryFiles: Map<string, Uint8Array>;
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
  /** Rename or move a file or directory as another program would (watchers are notified). */
  externalRename(from: string, to: string): void;
  /** Messages of the question dialogs shown so far. */
  readonly questions: readonly string[];
  /** The paths each save dialog suggested, in order. */
  readonly saveDialogs: readonly string[];
  /** Whether this window has closed. */
  readonly closed: boolean;
  /** Versions installed (and restarted into) so far. */
  readonly updatesInstalled: readonly string[];
  /** The application menu last installed with `setMenu`. */
  readonly menu: readonly MenuSpec[];
  /** Activate a menu item by id, as a click in a native menu would. */
  runMenuItem(id: string): void;
}

export function createMemoryPlatform(options: MemoryPlatformOptions = {}): MemoryPlatform {
  const files = new Map(Object.entries(options.files ?? {}));
  const binaryFiles = new Map(
    Object.entries(options.binaryFiles ?? {}).map(([path, base64]) => [path, fromBase64(base64)]),
  );
  /** Every file path, text or binary. */
  const filePaths = () => [...files.keys(), ...binaryFiles.keys()];
  const isFile = (path: string) => files.has(path) || binaryFiles.has(path);
  const assetUrls = new Map<Uint8Array, string>();
  // The config directory always exists, so settings.json can be created from outside.
  const directories = new Set([
    memorySettingsPath.slice(0, memorySettingsPath.lastIndexOf("/")),
    memoryThemesPath,
    ...(options.directories ?? []),
  ]);
  const appData = new Map(Object.entries(options.appData ?? {}));
  const trash: string[] = [];
  const dialogResults = [...(options.openDialogResults ?? [])];
  const saveDialogResults = [...(options.saveDialogResults ?? [])];
  const saveDialogs: string[] = [];
  const folderDialogResults = [...(options.openFolderDialogResults ?? [])];
  const watchers = new Set<{ root: string; onChange: (paths: readonly string[]) => void }>();
  const questionResults = [...(options.questionDialogResults ?? [])];
  const questions: string[] = [];
  const updatesInstalled: string[] = [];
  let commands: Extract<MenuItemSpec, { kind: "command" }>[] = [];
  let installedMenu: readonly MenuSpec[] = [];
  let windowTitle = "";
  const openedUrls: string[] = [];
  let closeHandler: (() => Promise<boolean>) | null = null;
  let closed = false;
  const settingsListeners = new Set<(file: SettingsFile) => void>();
  const recoveryPath = (id: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid recovery snapshot id: ${id}`);
    return `${memoryRecoveryDir}/${id}.json`;
  };
  // Like the backend, the snapshots of the previous run are those present at start-up.
  let leftOver: RecoverySnapshot[] | null = [...files]
    .filter(([path]) => path.startsWith(`${memoryRecoveryDir}/`) && path.endsWith(".json"))
    .map(([path, contents]) => ({
      id: path.slice(memoryRecoveryDir.length + 1, -".json".length),
      contents,
    }));
  const fileWatchers = new Set<{ readonly path: string; readonly onChange: () => void }>();

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
    directories.has(path) || filePaths().some((f) => f.startsWith(`${path}/`));
  const exists = (path: string): boolean => isFile(path) || isDirectory(path);
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
    for (const watcher of fileWatchers) {
      // The file itself, or a directory around it that was removed or renamed.
      if (paths.some((p) => within(watcher.path, p))) setTimeout(() => watcher.onChange(), 0);
    }
  }

  function move(from: string, to: string): void {
    const moved = (p: string) => to + p.slice(from.length);
    for (const map of [files, binaryFiles] as Map<string, unknown>[]) {
      for (const [p, contents] of [...map]) {
        if (within(p, from)) {
          map.delete(p);
          map.set(moved(p), contents);
        }
      }
    }
    for (const d of [...directories]) {
      if (within(d, from)) {
        directories.delete(d);
        directories.add(moved(d));
      }
    }
  }

  function remove(path: string): void {
    for (const key of [...files.keys()]) if (within(key, path)) files.delete(key);
    for (const key of [...binaryFiles.keys()]) if (within(key, path)) binaryFiles.delete(key);
    for (const dir of [...directories]) if (within(dir, path)) directories.delete(dir);
  }

  return {
    locale: options.locale ?? navigator.language,
    files,
    binaryFiles,
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
      // Mirrors the backend's file watchers: every write is reported, MINT's own included.
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
    get saveDialogs() {
      return saveDialogs;
    },
    async showSaveDialog({ defaultPath }) {
      saveDialogs.push(defaultPath);
      return saveDialogResults.shift() ?? null;
    },
    async showOpenFolderDialog() {
      return folderDialogResults.shift() ?? null;
    },
    async readDirectory(path) {
      if (!isDirectory(path)) throw new Error(`No such directory: ${path}`);
      const children = new Map<string, DirectoryEntry>();
      const prefix = `${path}/`;
      for (const p of [...filePaths(), ...directories]) {
        if (!p.startsWith(prefix)) continue;
        const name = p.slice(prefix.length).split("/")[0] ?? "";
        const child = prefix + name;
        if (!children.has(name)) {
          children.set(name, {
            name,
            path: child,
            kind: isFile(child) ? "file" : "directory",
          });
        }
      }
      return [...children.values()];
    },
    async listFolderFiles(root, extensions) {
      if (!isDirectory(root)) return [];
      const prefix = `${root}/`;
      const inFolder = filePaths().filter((p) => p.startsWith(prefix));
      const ignores = createIgnoreRules(
        inFolder
          .filter((p) => p.endsWith("/.gitignore"))
          .map((p) => ({ dir: parentOf(p).slice(root.length + 1), text: files.get(p) ?? "" })),
      );
      const wanted = extensions.map((e) => `.${e.toLowerCase()}`);
      return inFolder
        .filter((p) => {
          const relative = p.slice(prefix.length);
          if (relative.split("/").some((segment) => segment.startsWith("."))) return false;
          if (wanted.length > 0 && !wanted.some((e) => p.toLowerCase().endsWith(e))) return false;
          return !ignores.isIgnored(relative);
        })
        .sort();
    },
    async searchFolder(root, query, extensions, listener) {
      const regexp = searchRegExp(query);
      const paths = await this.listFolderFiles(root, extensions);
      let cancelled = false;
      // Like the backend, results arrive asynchronously, one file at a time.
      const next = (index: number) => {
        if (cancelled) return;
        const path = paths[index];
        if (path === undefined) {
          listener.onDone({ truncated: false });
          return;
        }
        const lines = searchText(files.get(path) ?? "", regexp);
        if (lines.length > 0) listener.onFile({ path, lines });
        setTimeout(() => next(index + 1));
      };
      setTimeout(() => next(0));
      return () => {
        cancelled = true;
      };
    },
    async saveAsset(directory, fileName, data) {
      if (isFile(directory)) throw new Error(`Not a directory: ${directory}`);
      const dot = fileName.lastIndexOf(".");
      const [stem, extension] =
        dot > 0 ? [fileName.slice(0, dot), fileName.slice(dot)] : [fileName, ""];
      let path = `${directory}/${fileName}`;
      for (let n = 1; exists(path); n++) path = `${directory}/${stem}-${n}${extension}`;
      directories.add(directory);
      binaryFiles.set(path, data.slice());
      notify(path);
      return path;
    },
    assetUrl(path) {
      const data = binaryFiles.get(path);
      if (!data) return null;
      let url = assetUrls.get(data);
      if (!url) {
        url = URL.createObjectURL(new Blob([data.slice()], { type: mimeType(path) }));
        assetUrls.set(data, url);
      }
      return url;
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
      move(from, to);
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
    async watchFile(path, onChange) {
      const watcher = { path, onChange };
      fileWatchers.add(watcher);
      return () => fileWatchers.delete(watcher);
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
    async themesPath() {
      return memoryThemesPath;
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
      installedMenu = menu;
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
    listPaths() {
      const all = new Set([...filePaths(), ...directories]);
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
    get menu() {
      return installedMenu;
    },
    async takeRecoverySnapshots() {
      const snapshots = leftOver ?? [];
      leftOver = null;
      return snapshots;
    },
    async writeRecoverySnapshot(id, contents) {
      files.set(recoveryPath(id), contents);
    },
    async deleteRecoverySnapshot(id) {
      files.delete(recoveryPath(id));
    },
    externalRename(from, to) {
      move(from, to);
      notify(from, to);
    },
    runMenuItem(id) {
      const command = commands.find((c) => c.id === id);
      if (!command) throw new Error(`No menu item: ${id}`);
      command.run();
    },
  };
}

/** The backend's matching rules (`search.rs`) in JavaScript regular expression syntax. */
function searchRegExp(query: FolderSearchQuery): RegExp {
  let source = query.regexp ? query.pattern : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (query.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  // Throws a SyntaxError for an invalid pattern, as the backend rejects it.
  return new RegExp(source, query.caseSensitive ? "gu" : "giu");
}

function searchText(text: string, regexp: RegExp): LineMatch[] {
  const lines: LineMatch[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r+$/, "");
    const ranges: [number, number][] = [];
    for (const match of line.matchAll(regexp)) {
      if (match[0].length > 0) ranges.push([match.index, match.index + match[0].length]);
    }
    if (ranges.length > 0) lines.push({ line: index + 1, text: line, ranges });
  });
  return lines;
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const mimeTypes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function mimeType(path: string): string {
  return (
    mimeTypes[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"
  );
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
