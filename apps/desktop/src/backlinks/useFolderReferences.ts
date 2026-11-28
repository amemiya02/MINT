import { useEffect, useState } from "react";
import type { FolderTree } from "../folder/file-tree.ts";
import { useFolderRows } from "../folder/useFolderRows.ts";
import type { Platform } from "../platform/platform.ts";
import { useDialect } from "../settings/useDialect.ts";
import { type FolderReference, folderReferences } from "./references.ts";

export function useFolderReferences(
  platform: Platform,
  tree: FolderTree | null,
  wikilinks: boolean,
  target?: string,
  hasAccess?: () => boolean,
) {
  const revision = useFolderRows(tree);
  const dialect = useDialect(wikilinks);
  const [results, setResults] = useState<FolderReference[] | "error" | null>(null);
  useEffect(() => {
    if (!tree || !revision) return;
    let active = true;
    const canRead = () => active && (hasAccess?.() ?? true);
    void folderReferences(platform, tree.root, dialect, canRead, target).then(
      (links) => {
        if (canRead()) setResults(links);
      },
      () => {
        if (canRead()) setResults("error");
      },
    );
    return () => {
      active = false;
    };
  }, [platform, tree, target, dialect, revision, hasAccess]);
  return results;
}
