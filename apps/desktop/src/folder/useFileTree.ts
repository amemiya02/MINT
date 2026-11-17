import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/**
 * The file tree of a folder: lists directories lazily as they are expanded and
 * keeps the listed directories in sync with the disk through a folder watcher,
 * re-reading only those a change touches.
 */
export function useFileTree(platform: Platform, root: string) {
  const [children, setChildren] = useState<ReadonlyMap<string, DirectoryEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const listed = useRef(new Set<string>());

  const load = useCallback(
    async (dir: string) => {
      listed.current.add(dir);
      let entries: DirectoryEntry[] | null;
      try {
        entries = sortEntries(await platform.readDirectory(dir));
      } catch {
        // The directory is gone (deleted or renamed elsewhere): stop listing it.
        entries = null;
        listed.current.delete(dir);
      }
      setChildren((previous) => {
        const next = new Map(previous);
        if (entries) next.set(dir, entries);
        else next.delete(dir);
        return next;
      });
    },
    [platform],
  );

  /** Re-read every listed directory. */
  const refresh = useCallback(
    () => Promise.all([...listed.current].map(load)).then(() => undefined),
    [load],
  );

  useEffect(() => {
    listed.current = new Set();
    setChildren(new Map());
    setExpanded(new Set());
    void load(root);
    let stop: (() => void) | null = null;
    let cancelled = false;
    // Changes are gathered for a moment, then only the directories they touch are re-read.
    const changed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const dirs = affectedDirectories(listed.current, root, changed);
      changed.clear();
      for (const dir of dirs) void load(dir);
    };
    void platform
      .watchFolder(root, (paths) => {
        for (const path of paths) changed.add(path);
        timer ??= setTimeout(flush, changeDelay);
      })
      .then((unwatch) => {
        if (cancelled) unwatch();
        else stop = unwatch;
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stop?.();
    };
  }, [platform, root, load]);

  const expand = useCallback(
    async (dir: string) => {
      setExpanded((previous) => new Set(previous).add(dir));
      await load(dir);
    },
    [load],
  );

  const collapse = useCallback((dir: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      next.delete(dir);
      return next;
    });
  }, []);

  /** Keep expanded directories expanded after `from` was renamed to `to`. */
  const renamed = useCallback((from: string, to: string) => {
    setExpanded((previous) => new Set([...previous].map((p) => rebasePath(p, from, to))));
    listed.current = new Set([...listed.current].map((p) => rebasePath(p, from, to)));
  }, []);

  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const walk = (dir: string, level: number) => {
      for (const entry of children.get(dir) ?? []) {
        const open = entry.kind === "directory" && expanded.has(entry.path);
        out.push({ entry, level, expanded: open });
        if (open) walk(entry.path, level + 1);
      }
    };
    walk(root, 1);
    return out;
  }, [children, expanded, root]);

  return { rows, children, expand, collapse, refresh, renamed };
}
