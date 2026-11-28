import { useEffect, useState } from "react";
import { parse } from "yaml";
import { useT } from "../i18n/index.ts";
import { documentExtensions, relativePath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { canReadFolder, type PluginManifest } from "./host.ts";
import { pluginName } from "./Plugins.tsx";

function tagsOf(source: string): string[] {
  if (!source.startsWith("---") && !source.startsWith("\uFEFF---")) return [];
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*\r?$/m.exec(source);
  if (header?.index !== 0) return [];
  try {
    const values: unknown = parse(header[1] ?? "")?.tags;
    const tags = Array.isArray(values) ? values : [values];
    return [
      ...new Set(
        tags
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

async function readTagIndex(id: string, folder: string, platform: Platform, signal: AbortSignal) {
  const allowed = () => !signal.aborted && canReadFolder(id);
  const index = new Map<string, string[]>();
  if (!allowed()) return index;
  for (const path of await platform.listFolderFiles(folder, documentExtensions)) {
    if (!allowed()) break;
    let source: string;
    try {
      source = await platform.readTextFile(path);
    } catch {
      // A document may have disappeared since the walk or contain invalid UTF-8.
      continue;
    }
    for (const tag of tagsOf(source)) {
      const matches = index.get(tag);
      if (matches) matches.push(path);
      else index.set(tag, [path]);
    }
  }
  return index;
}

export function TagBrowser({
  manifest,
  granted,
  folder,
  platform,
  onOpen,
}: {
  manifest: PluginManifest;
  granted: boolean;
  folder: string | null;
  platform: Platform;
  onOpen: (path: string) => void;
}) {
  const t = useT();
  const [index, setIndex] = useState<Map<string, string[]> | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    if (!folder || !granted) return;
    const controller = new AbortController();
    readTagIndex(manifest.id, folder, platform, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted && canReadFolder(manifest.id)) setIndex(result);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [manifest.id, folder, granted, platform]);
  const tags = [...(index?.keys() ?? [])].sort((a, b) => a.localeCompare(b));
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
      ) : !index ? (
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
