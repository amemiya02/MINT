import type { FolderTree } from "../folder/file-tree.ts";
import { useT } from "../i18n/index.ts";
import { relativePath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import type { FolderReference } from "./references.ts";
import { useFolderReferences } from "./useFolderReferences.ts";

export function Backlinks({
  platform,
  tree,
  wikilinks,
  targetPath,
  onOpen,
}: {
  platform: Platform;
  wikilinks: boolean;
  tree: FolderTree | null;
  targetPath: string | null;
  onOpen: (link: FolderReference) => void;
}) {
  const t = useT();
  const folder = tree?.root ?? null;
  const results = useFolderReferences(
    platform,
    targetPath ? tree : null,
    wikilinks,
    targetPath ?? undefined,
  );
  return (
    <aside
      aria-label={t("backlinks.label")}
      className="flex h-full w-60 shrink-0 flex-col gap-2 overflow-auto border-r border-(--mint-border) bg-(--mint-sidebar-bg) p-2 text-sm"
    >
      <h2 className="font-semibold">{t("backlinks.label")}</h2>
      {!folder || !targetPath ? (
        <p>{t("backlinks.needDocument")}</p>
      ) : results === "error" ? (
        <p role="alert">{t("plugin.folderError")}</p>
      ) : !results ? (
        <p>{t("search.searching")}</p>
      ) : !results.length ? (
        <p>{t("backlinks.empty")}</p>
      ) : (
        results.map((link) => (
          <button
            type="button"
            key={JSON.stringify([link.sourcePath, link.from])}
            onClick={() => onOpen(link)}
            className="break-words rounded px-2 py-1 text-left hover:bg-(--mint-hover)"
          >
            <span className="block font-medium">
              {relativePath(folder, link.sourcePath)} · {link.line}:{link.column}
            </span>
            {link.context}
          </button>
        ))
      )}
    </aside>
  );
}
