import { useMemo, useState } from "react";
import { useT } from "../i18n/index.ts";
import { relativePath } from "../paths.ts";
import { type FolderViewProps, useFolderProperties } from "./folder-properties.ts";
import { canReadFolder } from "./host.ts";
import { pluginName } from "./Plugins.tsx";

export function TagBrowser(props: FolderViewProps) {
  const { manifest, granted, folder, onOpen } = props;
  const t = useT();
  const { documents, failed } = useFolderProperties(props);
  const [selected, setSelected] = useState("");
  const index = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const { path, properties } of documents ?? []) {
      const values = properties.tags;
      const tags = (Array.isArray(values) ? values : [values])
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean);
      for (const tag of new Set(tags)) {
        const matches = result.get(tag);
        if (matches) matches.push(path);
        else result.set(tag, [path]);
      }
    }
    return result;
  }, [documents]);
  const tags = [...index.keys()].sort((a, b) => a.localeCompare(b));
  const current = selected || tags[0] || "";
  return (
    <aside
      aria-label={pluginName(manifest, t)}
      className="flex h-full w-60 shrink-0 flex-col gap-2 overflow-auto border-r border-(--mint-border) bg-(--mint-sidebar-bg) p-2 text-sm"
    >
      <h2 className="font-semibold">{pluginName(manifest, t)}</h2>
      {!granted ? (
        <p role="alert">{t("plugin.folderDenied")}</p>
      ) : !folder ? (
        <p>{t("plugin.needFolder")}</p>
      ) : failed ? (
        <p role="alert">{t("plugin.folderError")}</p>
      ) : !documents ? (
        <p>{t("plugin.loadingTags")}</p>
      ) : tags.length === 0 ? (
        <p>{t("plugin.noTags")}</p>
      ) : (
        <>
          <label>
            {t("plugin.tag")}{" "}
            <select value={current} onChange={(e) => setSelected(e.target.value)}>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
          {index.get(current)?.map((path) => (
            <button
              type="button"
              key={path}
              className="break-all rounded px-2 py-1 text-left hover:bg-(--mint-hover)"
              onClick={() => {
                if (canReadFolder(manifest.id)) onOpen(path);
              }}
            >
              {relativePath(folder, path)}
            </button>
          ))}
        </>
      )}
    </aside>
  );
}
