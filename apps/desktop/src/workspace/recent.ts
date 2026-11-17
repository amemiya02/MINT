import { useCallback, useEffect, useRef, useState } from "react";
import type { Platform } from "../platform/platform.ts";

/** Recently opened documents and folders, most recent first. Kept in the app data directory. */
export interface RecentList {
  readonly documents: readonly string[];
  readonly folders: readonly string[];
}

const fileName = "recent.json";
const limit = 10;
const empty: RecentList = { documents: [], folders: [] };

async function loadRecent(platform: Platform): Promise<RecentList> {
  try {
    const parsed: unknown = JSON.parse((await platform.readAppData(fileName)) ?? "null");
    const list = (value: unknown) =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    if (typeof parsed !== "object" || parsed === null) return empty;
    const record = parsed as Record<string, unknown>;
    return { documents: list(record.documents), folders: list(record.folders) };
  } catch {
    // A missing or damaged list is not worth bothering the user about.
    return empty;
  }
}

function remember(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, limit);
}

export function useRecent(platform: Platform) {
  const [recent, setRecent] = useState<RecentList>(empty);
  const current = useRef<Promise<RecentList>>(Promise.resolve(empty));

  useEffect(() => {
    current.current = loadRecent(platform);
    void current.current.then(setRecent);
  }, [platform]);

  const add = useCallback(
    (kind: "document" | "folder", path: string) => {
      // Chain updates so concurrent calls never lose each other's entries.
      current.current = current.current.then(async (list) => {
        const next: RecentList =
          kind === "document"
            ? { ...list, documents: remember(list.documents, path) }
            : { ...list, folders: remember(list.folders, path) };
        setRecent(next);
        try {
          await platform.writeAppData(fileName, JSON.stringify(next));
        } catch {
          // Failing to update the recent list must not interrupt opening a file.
        }
        return next;
      });
    },
    [platform],
  );

  return { recent, add };
}
