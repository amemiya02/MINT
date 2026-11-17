import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirectoryEntry, Platform } from "../platform/platform.ts";
import { isHiddenName, rebasePath } from "./paths.ts";

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

/**
 * The file tree of a folder: lists directories lazily as they are expanded and
 * keeps every listed directory in sync with the disk through a folder watcher.
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
    void platform
      .watchFolder(root, () => void refresh())
      .then((unwatch) => {
        if (cancelled) unwatch();
        else stop = unwatch;
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [platform, root, load, refresh]);

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
