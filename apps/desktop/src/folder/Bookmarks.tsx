import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { baseName, parentPath } from "../paths.ts";

// One key per absolute path keeps additions and removals independent across windows.
const prefix = "mint.bookmark:";

function readBookmarks(): string[] {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort();
}

export function Bookmarks({
  activePath,
  onOpen,
}: {
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const t = useT();
  const [paths, setPaths] = useState(readBookmarks);
  const [error, setError] = useState(false);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(prefix)) setPaths(readBookmarks());
    };
    window.addEventListener("storage", onStorage);
    setPaths(readBookmarks());
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function update(path: string, add: boolean) {
    try {
      if (add) localStorage.setItem(prefix + path, "1");
      else localStorage.removeItem(prefix + path);
      setPaths(readBookmarks());
      setError(false);
    } catch {
      setError(true);
    }
  }
  return (
    <aside
      aria-label={t("bookmarks.label")}
      className="flex h-full w-60 shrink-0 flex-col gap-2 overflow-auto border-r border-(--mint-border) bg-(--mint-sidebar-bg) p-2 text-sm"
    >
      <h2 className="font-semibold">{t("bookmarks.label")}</h2>
      <button
        type="button"
        disabled={!activePath || paths.includes(activePath)}
        onClick={() => activePath && update(activePath, true)}
        className="rounded border border-(--mint-border) px-2 py-1 enabled:hover:bg-(--mint-hover) disabled:opacity-50"
      >
        {t("bookmarks.add")}
      </button>
      {error && <p role="alert">{t("bookmarks.saveError")}</p>}
      {!paths.length && <p className="text-(--mint-muted)">{t("bookmarks.empty")}</p>}
      <ul>
        {paths.map((path) => (
          <li key={path} className="flex items-center gap-1">
            <button
              type="button"
              title={path}
              aria-label={path}
              onClick={() => onOpen(path)}
              className="min-w-0 flex-1 rounded px-2 py-1 text-left hover:bg-(--mint-hover)"
            >
              <span className="block break-all font-medium">{baseName(path)}</span>
              <span className="block break-all text-xs text-(--mint-muted)">
                {parentPath(path)}
              </span>
            </button>
            <button
              type="button"
              aria-label={t("bookmarks.remove", { path })}
              title={t("bookmarks.remove", { path })}
              onClick={() => update(path, false)}
              className="rounded px-2 py-1 text-(--mint-muted) hover:bg-(--mint-hover)"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
