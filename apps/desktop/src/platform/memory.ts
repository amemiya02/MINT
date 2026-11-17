import type { DirectoryEntry, MenuItemSpec, MenuSpec, Platform } from "./platform.ts";

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
  /** Activate a menu item by id, as a click in a native menu would. */
  runMenuItem(id: string): void;
}

export function createMemoryPlatform(options: MemoryPlatformOptions = {}): MemoryPlatform {
  const files = new Map(Object.entries(options.files ?? {}));
  const directories = new Set(options.directories ?? []);
  const appData = new Map(Object.entries(options.appData ?? {}));
  const trash: string[] = [];
  const dialogResults = [...(options.openDialogResults ?? [])];
  const folderDialogResults = [...(options.openFolderDialogResults ?? [])];
  const watchers = new Set<{ root: string; onChange: (paths: readonly string[]) => void }>();
  let commands: Extract<MenuItemSpec, { kind: "command" }>[] = [];
  let windowTitle = "";

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
      notify(path);
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
    async setWindowTitle(title) {
      windowTitle = title;
      document.title = title;
    },
    async setMenu(menu: readonly MenuSpec[]) {
      commands = menu.flatMap((m) => m.items.filter((i) => i.kind === "command"));
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
    event.key.toLowerCase() === key &&
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.shiftKey === mods.has("shift") &&
    event.altKey === (mods.has("alt") || mods.has("option"))
  );
}
