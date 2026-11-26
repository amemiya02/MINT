import { isHiddenName, isWithin, parentPath, rebasePath } from "../paths.ts";
import type { DirectoryEntry, Platform } from "../platform/platform.ts";

/** One visible row of the file tree, in display order. */
export interface TreeRow {
  readonly entry: DirectoryEntry;
  /** 1 for children of the folder root. */
  readonly level: number;
  readonly expanded: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortEntries(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return entries
    .filter((e) => !isHiddenName(e.name))
    .sort((a, b) =>
      a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "directory" ? -1 : 1,
    );
}

/** How long changes reported by the folder watcher are gathered before the tree re-reads directories. */
const changeDelay = 100;

/**
 * The listed directories whose listing changes when `paths` change: the
 * nearest listed directory around each path (its parent, or the ancestor that
 * shows a new or removed directory), and listed directories that were
 * themselves changed (removed or renamed away), so they are dropped.
 */
function affectedDirectories(
  listed: ReadonlySet<string>,
  root: string,
  paths: Iterable<string>,
): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    if (!isWithin(path, root)) continue;
    for (const dir of listed) if (isWithin(dir, path)) dirs.add(dir);
    for (let dir = parentPath(path); isWithin(dir, root); dir = parentPath(dir)) {
      if (listed.has(dir)) {
        dirs.add(dir);
        break;
      }
      if (dir === root) break;
    }
  }
  return dirs;
}

/** The listings and mutations of one open Folder. Subscribe to its visible rows. */
export class FolderTree {
  private readonly children = new Map<string, DirectoryEntry[]>();
  private expanded = new Set<string>();
  // Include in-flight listings in invalidation. A superseded read cannot publish stale rows.
  private readonly listed = new Map<string, symbol>();
  private readonly changed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private rows: TreeRow[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private unwatch?: () => void;
  private disposed = false;

  private constructor(
    private readonly platform: Platform,
    readonly root: string,
  ) {}

  static async open(platform: Platform, root: string, onWatchError: (error: unknown) => void) {
    const tree = new FolderTree(platform, root);
    // Start watching alongside the first listing. Native watch setup can take time on a large Folder.
    void platform
      .watchFolder(root, (paths) => tree.changedOnDisk(paths))
      .then(
        (stop) => {
          if (tree.disposed) stop();
          else tree.unwatch = stop;
        },
        (error: unknown) => {
          if (!tree.disposed) onWatchError(error);
        },
      );
    try {
      await tree.load(root, true);
      return tree;
    } catch (error) {
      tree.dispose();
      throw error;
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.unwatch?.();
    this.listed.clear();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRows = () => this.rows;

  private publish() {
    const rows: TreeRow[] = [];
    const walk = (dir: string, level: number) => {
      for (const entry of this.children.get(dir) ?? []) {
        const expanded = entry.kind === "directory" && this.expanded.has(entry.path);
        rows.push({ entry, level, expanded });
        if (expanded) walk(entry.path, level + 1);
      }
    };
    walk(this.root, 1);
    this.rows = rows;
    for (const listener of this.listeners) listener();
  }

  private async load(dir: string, opening = false) {
    if (this.disposed) return;
    const request = Symbol();
    this.listed.set(dir, request);
    try {
      const entries = await this.platform.readDirectory(dir);
      if (this.listed.get(dir) !== request) return;
      this.children.set(dir, sortEntries(entries));
    } catch (error) {
      if (this.listed.get(dir) !== request) return;
      if (opening) throw error;
      this.listed.delete(dir);
      this.children.delete(dir);
      this.expanded.delete(dir);
    }
    this.publish();
  }

  private changedOnDisk(paths: readonly string[]) {
    if (this.disposed) return;
    for (const path of paths) this.changed.add(path);
    this.timer ??= setTimeout(() => void this.reconcile([]), changeDelay);
  }

  private async reconcile(paths: readonly string[]) {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const path of paths) this.changed.add(path);
    const dirs = affectedDirectories(new Set(this.listed.keys()), this.root, this.changed);
    this.changed.clear();
    await Promise.all([...dirs].map((dir) => this.load(dir)));
  }

  async expand(dir: string) {
    this.expanded.add(dir);
    await this.load(dir);
  }

  collapse(dir: string) {
    this.expanded.delete(dir);
    this.publish();
  }

  availableName(parent: string, stem: string, ext: string) {
    const taken = new Set(this.children.get(parent)?.map((entry) => entry.name));
    for (let n = 1; ; n++) {
      const name = n === 1 ? stem + ext : `${stem} ${n}${ext}`;
      if (!taken.has(name)) return name;
    }
  }

  async create(path: string, kind: DirectoryEntry["kind"]) {
    if (kind === "file") await this.platform.createFile(path);
    else await this.platform.createDirectory(path);
    await this.reconcile([path]);
    if (kind === "directory") await this.expand(path);
  }

  async rename(from: string, to: string) {
    await this.platform.rename(from, to);
    this.expanded = new Set([...this.expanded].map((path) => rebasePath(path, from, to)));
    for (const [dir, request] of [...this.listed]) {
      if (!isWithin(dir, from)) continue;
      this.listed.delete(dir);
      this.children.delete(dir);
      this.listed.set(rebasePath(dir, from, to), request);
    }
    void this.reconcile([from, to]);
  }

  async trash(path: string) {
    await this.platform.moveToTrash(path);
    void this.reconcile([path]);
  }
}
