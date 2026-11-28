import { sendBrowserModelRequest } from "../ai/browser-model.ts";
import {
  createModelSender,
  modelApiKey,
  modelEndpoint,
  type SavedModelConnection,
} from "../ai/model.ts";
import { baseName, parentPath } from "../paths.ts";
import { createIgnoreRules } from "./gitignore.ts";
import { type MemoryExternalAgentOptions, memoryExternalAgent } from "./memory-external-agent.ts";
import { pickBrowserFile } from "./pick-file.ts";
import type {
  DirectoryEntry,
  FolderSearchQuery,
  LineMatch,
  MenuItemSpec,
  MenuSpec,
  OpenedPath,
  Platform,
  RecoverySnapshot,
  SettingsFile,
  SettingsValues,
  StoredAnnotations,
  ZoteroItem,
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
  readonly externalAgent?: MemoryExternalAgentOptions;
  /** Initial files, keyed by absolute `/`-separated path. Their parent directories exist implicitly. */
  readonly files?: Readonly<Record<string, string>>;
  /** Extra (possibly empty) directories. */
  readonly directories?: readonly string[];
  /** Paths the open dialog returns, in order; `null` simulates cancelling. */
  readonly openDialogResults?: readonly (string | null)[];
  /** Paths selected as import packages, in order. */
  readonly fileDialogResults?: readonly (string | null)[];
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
  readonly zoteroItems?: readonly ZoteroItem[];
  readonly locale?: string;
  /** Text on the system clipboard; `null` means it holds no text (reading it fails). */
  readonly clipboardText?: string | null;
  /** Documents and folders handed to MINT from outside before the window started (file association, command line). */
  readonly openedPaths?: readonly OpenedPath[];
  /** Documents that cannot be watched for changes on disk (`watchFile` rejects). */
  readonly unwatchablePaths?: readonly string[];
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
  /** Put text on the system clipboard, as another program would; `null` puts something that is not text. */
  setClipboardText(text: string | null): void;
  /** Hand documents or folders to MINT from outside, as a double-click in the file manager would. */
  openFromOutside(paths: readonly OpenedPath[]): void;
  /** Rename or move a file or directory as another program would (watchers are notified). */
  externalRename(from: string, to: string): void;
  /** Messages of the question dialogs shown so far. */
  readonly questions: readonly string[];
  /** Pending file-picker selections. */
  readonly fileDialogResults: (string | null)[];
  /** The paths each save dialog suggested, in order. */
  readonly saveDialogs: readonly string[];
  /** The directories listed with `readDirectory` so far, in order. */
  readonly directoriesRead: readonly string[];
  /** The documents printed so far, in order. */
  readonly printed: readonly { readonly html: string; readonly title: string }[];
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
    parentPath(memorySettingsPath),
    memoryThemesPath,
    ...(options.directories ?? []),
  ]);
  const appData = new Map(Object.entries(options.appData ?? {}));
  const taskRoot = "ai/tasks/";
  const taskRecord = (id: string) => `${taskRoot}${id}/review.json`;
  const trash: string[] = [];
  const dialogResults = [...(options.openDialogResults ?? [])];
  const saveDialogResults = [...(options.saveDialogResults ?? [])];
  const saveDialogs: string[] = [];
  const printed: { html: string; title: string }[] = [];
  const directoriesRead: string[] = [];
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
  let clipboardText: string | null =
    options.clipboardText === undefined ? "" : options.clipboardText;
  const settingsListeners = new Set<(file: SettingsFile) => void>();
  let pendingOpens: OpenedPath[] = [...(options.openedPaths ?? [])];
  const openListeners = new Set<(paths: readonly OpenedPath[]) => void>();
  /** Like the backend, waiting paths go to one listener, which takes them all. */
  function deliverOpens() {
    const [listener] = openListeners;
    if (!listener || pendingOpens.length === 0) return;
    const paths = pendingOpens;
    pendingOpens = [];
    listener(paths);
  }
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

  /** The `.gitignore` rules of the folder `root`. */
  function ignoreRulesOf(root: string) {
    const prefix = `${root}/`;
    return createIgnoreRules(
      filePaths()
        .filter((p) => p.startsWith(prefix) && p.endsWith("/.gitignore"))
        .map((p) => ({ dir: parentOf(p).slice(root.length + 1), text: files.get(p) ?? "" })),
    );
  }

  /** Like the backend's folder watcher: changes inside `.git` and to ignored entries are not reported. */
  function reported(path: string, root: string): boolean {
    if (path === root) return true;
    const relative = path.slice(root.length + 1);
    if (relative.split("/").includes(".git")) return false;
    return !ignoreRulesOf(root).isIgnored(relative);
  }

  function notify(...paths: string[]): void {
    for (const watcher of watchers) {
      const touched = paths.filter((p) => within(p, watcher.root) && reported(p, watcher.root));
      // Like a real file watcher, events arrive asynchronously.
      if (touched.length > 0) setTimeout(() => watcher.onChange(touched), 0);
    }
    for (const watcher of fileWatchers) {
      // The file itself, or a directory around it that was removed or renamed.
      if (paths.some((p) => within(watcher.path, p))) setTimeout(() => watcher.onChange(), 0);
    }
  }

  function moveHistory(from: string, to: string) {
    if (from === to) return;
    const restoring: [string, string][] = [];
    const detached = crypto.randomUUID();
    for (const [key, value] of [...appData]) {
      if (key.startsWith(taskRoot) && key.endsWith("/review.json")) {
        const task = JSON.parse(value);
        if (task.path !== null && within(task.path, from) && isFile(task.path)) {
          appData.set(key, JSON.stringify({ ...task, path: to + task.path.slice(from.length) }));
        }
        continue;
      }
      const match = /^(history:|snapshot:\d+:|annotations:)([\s\S]+)$/.exec(key);
      const path = match?.[2];
      if (!match || !path) continue;
      if (within(path, from) && isFile(path)) {
        restoring.push([match[1] + to + path.slice(from.length), value]);
        appData.delete(key);
      } else if (within(path, to) && isFile(from + path.slice(to.length))) {
        appData.set(`detached:${detached}:${key}`, value);
        appData.delete(key);
      }
    }
    for (const [key, value] of restoring) appData.set(key, value);
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

  const modelConnections = new Map<
    string,
    {
      summary: SavedModelConnection;
      model: string;
      apiKey: string;
    }
  >();

  return {
    sendModelMessage: createModelSender(async (request, receive) => {
      if ("url" in request) return sendBrowserModelRequest(request, receive);
      const connection = modelConnections.get(request.connectionId);
      if (!connection) throw "connectionMissing";
      return sendBrowserModelRequest(
        {
          url: modelEndpoint(connection.summary.address),
          apiKey: connection.apiKey,
          body: { ...request.body, model: connection.model },
        },
        receive,
      );
    }),
    async listModelConnections() {
      return [...modelConnections.values()].map(({ summary }) => summary);
    },
    async saveModelConnection(connection) {
      const apiKey = modelApiKey(connection.apiKey);
      if (connection.lifetime === "persistent") throw "credentialStoreUnavailable";
      const summary = {
        id: crypto.randomUUID(),
        name: connection.name.trim(),
        address: connection.address.trim(),
        keySuffix: apiKey.length > 4 ? apiKey.slice(-4) : apiKey ? "" : null,
        lifetime: connection.lifetime,
      };
      modelConnections.set(summary.id, { summary, model: connection.model.trim(), apiKey });
      return summary;
    },
    async disconnectModelConnection(id) {
      modelConnections.delete(id);
    },
    async listZoteroItems(start) {
      if (!options.zoteroItems) throw new Error("unavailable");
      return {
        items: options.zoteroItems.slice(start, start + 50),
        next: options.zoteroItems.length > start + 50,
      };
    },
    externalAgent: memoryExternalAgent(options.externalAgent),
    writingTasks: {
      async list(path) {
        return [...appData.entries()].flatMap(([key, json]) => {
          if (!key.startsWith(taskRoot) || !key.endsWith("/review.json")) return [];
          const task = JSON.parse(json);
          return task.path === path ? [task] : [];
        });
      },
      async create(task) {
        const key = taskRecord(task.id);
        if (appData.has(key)) throw new Error("Writing task already exists");
        appData.set(key, JSON.stringify(task));
      },
      async update(task, expectedUpdatedAt) {
        const key = taskRecord(task.id);
        const previous = appData.get(key);
        if (previous === undefined) throw new Error("Writing task no longer exists");
        const stored = JSON.parse(previous);
        if (stored.updatedAt !== expectedUpdatedAt || task.updatedAt <= expectedUpdatedAt) {
          throw new Error("Writing task changed");
        }
        appData.set(key, JSON.stringify({ ...task, path: stored.path ?? task.path }));
      },
      async remove(id) {
        const prefix = `${taskRoot}${id}/`;
        for (const key of appData.keys()) if (key.startsWith(prefix)) appData.delete(key);
      },
    },
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
    async listVersions(path) {
      return JSON.parse(appData.get(`history:${path}`) ?? "[]") as number[];
    },
    async readVersion(path, id) {
      const text = appData.get(`snapshot:${id}:${path}`);
      if (text === undefined) throw new Error("Missing version");
      return text;
    },
    async recordVersion(path, text) {
      const key = `history:${path}`;
      const ids = JSON.parse(appData.get(key) ?? "[]") as number[];
      const last = ids.at(-1) ?? 0;
      if (appData.get(`snapshot:${last}:${path}`) === text) return;
      const id = Math.max(Date.now(), last + 1);
      appData.set(`snapshot:${id}:${path}`, text);
      appData.set(key, JSON.stringify([...ids, id]));
    },
    async readAnnotations(path) {
      return JSON.parse(appData.get(`annotations:${path}`) ?? "{}") as StoredAnnotations;
    },
    async updateAnnotations(path, changes) {
      const key = `annotations:${path}`;
      const current = JSON.parse(appData.get(key) ?? "{}") as StoredAnnotations;
      appData.set(key, JSON.stringify({ ...current, ...changes }));
    },
    async readBinaryFile(path) {
      const bytes = binaryFiles.get(path);
      if (bytes) return bytes.slice().buffer;
      return new TextEncoder().encode(await this.readTextFile(path)).buffer;
    },
    async writeBinaryFile(path, data) {
      requireParent(path);
      if (isDirectory(path)) throw new Error(`Is a directory: ${path}`);
      files.delete(path);
      binaryFiles.set(path, data.slice());
      notify(path);
    },
    async writeTextFile(path, text) {
      requireParent(path);
      binaryFiles.delete(path);
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
    fileDialogResults: [...(options.fileDialogResults ?? [])],
    async pickFile(accept) {
      const path = this.fileDialogResults.shift();
      if (path === undefined) return pickBrowserFile(accept);
      return path ? new File([await this.readBinaryFile(path)], baseName(path)) : null;
    },
    async showOpenDialog() {
      return dialogResults.shift() ?? null;
    },
    get printed() {
      return printed;
    },
    async printDocument(html, { title }) {
      printed.push({ html, title });
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
    get directoriesRead() {
      return directoriesRead;
    },
    async readDirectory(path) {
      directoriesRead.push(path);
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
      const ignores = ignoreRulesOf(root);
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
    async matchSearchLabels(query, labels) {
      const regexp = searchRegExp(query);
      return labels.flatMap((label, index) => (matchesLabel(label, regexp) ? [index] : []));
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
        const nameMatches = matchesLabel(baseName(path), regexp);
        if (nameMatches || lines.length > 0) listener.onFile({ path, nameMatches, lines });
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
    async ensureDocument(path, initialText) {
      if (isFile(path)) return;
      if (isDirectory(path)) throw new Error(`Is a directory: ${path}`);
      requireParent(path);
      files.set(path, initialText);
      notify(path);
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
    async applyDocumentEdit({ from, to, before, after }) {
      if (files.get(from) !== before) throw new Error(`${from}: file changed`);
      if (from !== to && exists(to)) throw new Error(`${to} already exists`);
      requireParent(to);
      moveHistory(from, to);
      files.delete(from);
      files.set(to, after);
      notify(from, to);
    },
    async rename(from, to) {
      if (!exists(from)) throw new Error(`No such file or directory: ${from}`);
      if (exists(to)) throw new Error(`${to} already exists`);
      requireParent(to);
      moveHistory(from, to);
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
      if (options.unwatchablePaths?.includes(path)) throw new Error("too many open files");
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
    async readClipboardText() {
      if (clipboardText === null) throw new Error("The clipboard holds no text");
      return clipboardText;
    },
    async writeClipboardText(text) {
      clipboardText = text;
    },
    setClipboardText(text) {
      clipboardText = text;
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
    onOpenPaths(listener) {
      openListeners.add(listener);
      setTimeout(deliverOpens);
      return () => openListeners.delete(listener);
    },
    openFromOutside(paths) {
      pendingOpens.push(...paths);
      setTimeout(deliverOpens);
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

function matchesLabel(label: string, regexp: RegExp): boolean {
  for (const match of label.matchAll(regexp)) if (match[0].length > 0) return true;
  return false;
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

/** Like `parentPath`, but the parent of a root-level path is `""` rather than `/`. */
function parentOf(path: string): string {
  const parent = parentPath(path);
  return parent === "/" ? "" : parent;
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
    // With Shift held, digits arrive as symbols (⇧1 is "!"), so fall back to the physical key too.
    (event.key.toLowerCase() === key ||
      event.code.toLowerCase() === `key${key}` ||
      event.code.toLowerCase() === `digit${key}`) &&
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.shiftKey === mods.has("shift") &&
    event.altKey === (mods.has("alt") || mods.has("option"))
  );
}
