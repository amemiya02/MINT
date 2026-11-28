import { useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform, ZoteroItem, ZoteroPage } from "../platform/platform.ts";

const pageSize = 50;
const buttonClass =
  "rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 disabled:opacity-50";

function bibliography(item: ZoteroItem, t: ReturnType<typeof useT>): string {
  return [
    t("materials.zotero.title", { value: item.title }),
    item.creators?.length && t("materials.zotero.creators", { value: item.creators.join(", ") }),
    item.date && t("materials.zotero.date", { value: item.date }),
    item.publication && t("materials.zotero.publication", { value: item.publication }),
    item.doi && t("materials.zotero.doi", { value: item.doi }),
    t("materials.zotero.link", { value: `zotero://select/library/items/${item.key}` }),
  ]
    .filter(Boolean)
    .join("\n");
}

export function ZoteroMaterialPicker({
  platform,
  add,
}: {
  readonly platform: Platform;
  readonly add: (name: string, text: string) => boolean;
}) {
  const t = useT();
  const [access, setAccess] = useState<"closed" | "prompt" | "allowed">("closed");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [results, setResults] = useState<{ page: ZoteroPage; query: string; start: number }>();
  const readId = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);

  function close() {
    readId.current++;
    setAccess("closed");
    setQuery("");
    setResults(undefined);
    setLoading(false);
    setFailed(false);
    trigger.current?.focus();
  }

  async function read(query: string, start = 0) {
    const id = ++readId.current;
    setLoading(true);
    setFailed(false);
    setResults(undefined);
    try {
      const page = await platform.listZoteroItems(start, query || undefined);
      if (id === readId.current) setResults({ page, query, start });
    } catch {
      if (id === readId.current) setFailed(true);
    } finally {
      if (id === readId.current) setLoading(false);
    }
  }

  return (
    <fieldset
      aria-label={t("materials.zotero.add")}
      className="space-y-2"
      onKeyDown={(event) => {
        if (event.key === "Escape" && access !== "closed" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={buttonClass}
        aria-expanded={access !== "closed"}
        onClick={() => (access === "closed" ? setAccess("prompt") : close())}
      >
        {t("materials.zotero.add")}
      </button>
      {access === "prompt" && (
        <fieldset
          aria-label={t("materials.zotero.tool")}
          className="space-y-2 rounded border border-(--mint-border) p-2"
        >
          <p role="status">{t("materials.zotero.confirm")}</p>
          <p>{t("materials.zotero.disclosure")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setAccess("allowed");
                void read("");
              }}
            >
              {t("materials.allowOnce")}
            </button>
            <button type="button" className={buttonClass} onClick={close}>
              {t("plugin.deny")}
            </button>
          </div>
        </fieldset>
      )}
      {access === "allowed" && (
        <fieldset
          aria-label={t("materials.zotero.tool")}
          className="space-y-2 rounded border border-(--mint-border) p-2"
        >
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-0 grow gap-1">
              {t("materials.zotero.search")}
              <input
                type="search"
                className="w-full rounded border border-(--mint-border) bg-(--mint-bg) p-1"
                value={query}
                maxLength={200}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (!loading) void read(query.trim());
                }}
              />
            </label>
            <button
              type="button"
              className={buttonClass}
              disabled={loading}
              onClick={() => void read(query.trim())}
            >
              {t("materials.zotero.searchButton")}
            </button>
            <button type="button" className={buttonClass} onClick={close}>
              {t("settings.close")}
            </button>
          </div>
          {loading && <p role="status">{t("zotero.loading")}</p>}
          {failed && <p role="alert">{t("zotero.unavailable")}</p>}
          {results && (
            <>
              {results.page.items.length === 0 && <p role="status">{t("zotero.empty")}</p>}
              <ul className="max-h-36 space-y-1 overflow-auto">
                {results.page.items.map((item) => (
                  <li key={item.key} className="space-y-1 wrap-anywhere">
                    <button
                      type="button"
                      className={`${buttonClass} text-start`}
                      onClick={() => {
                        if (
                          add(
                            t("materials.zotero.name", { title: item.title }),
                            bibliography(item, t),
                          )
                        )
                          close();
                      }}
                    >
                      {item.title}
                    </button>
                    <p className="text-(--mint-muted)">
                      {[...(item.creators ?? []), item.date, item.publication, item.key]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
              {(results.start > 0 || results.page.next) && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={results.start === 0}
                    onClick={() => void read(results.query, results.start - pageSize)}
                  >
                    {t("zotero.previous")}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={!results.page.next}
                    onClick={() => void read(results.query, results.start + pageSize)}
                  >
                    {t("zotero.more")}
                  </button>
                </div>
              )}
            </>
          )}
        </fieldset>
      )}
    </fieldset>
  );
}
