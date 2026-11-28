import type { RecentList } from "../folder/recent.ts";
import { useT } from "../i18n/index.ts";
import { baseName } from "../paths.ts";

/** What a window without documents shows: open buttons and the recently opened list. */
export function Welcome(props: {
  readonly recent: RecentList;
  readonly onNewDocument: () => void;
  readonly onDraft: () => void;
  readonly onPickDocument: () => void;
  readonly onPickFolder: () => void;
  readonly onOpenDocument: (path: string) => void;
  readonly onOpenFolder: (path: string) => void;
}) {
  const t = useT();
  const { recent } = props;
  const button =
    "rounded-md border border-(--mint-border) px-4 py-1.5 text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)";
  const entries = [
    ...recent.folders.map((path) => ({ path, open: props.onOpenFolder, folder: true })),
    ...recent.documents.map((path) => ({ path, open: props.onOpenDocument, folder: false })),
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-medium">{t("welcome.title")}</h1>
      <p className="text-sm text-(--mint-muted)">{t("welcome.body")}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={props.onNewDocument} className={button}>
          {t("welcome.write")}
        </button>
        <button type="button" onClick={props.onDraft} className={button}>
          {t("command.file.draftWithAi")}
        </button>
        <button type="button" onClick={props.onPickDocument} className={button}>
          {t("welcome.open")}
        </button>
        <button type="button" onClick={props.onPickFolder} className={button}>
          {t("welcome.openFolder")}
        </button>
      </div>
      {entries.length > 0 && (
        <section aria-labelledby="recent-heading" className="mt-6 w-full max-w-md text-left">
          <h2
            id="recent-heading"
            className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-(--mint-muted)"
          >
            {t("welcome.recent")}
          </h2>
          <ul>
            {entries.map((entry) => (
              <li key={`${entry.folder}:${entry.path}`}>
                <button
                  type="button"
                  onClick={() => entry.open(entry.path)}
                  className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
                >
                  <span className={entry.folder ? "font-medium" : ""}>
                    {baseName(entry.path)}
                    {entry.folder ? "/" : ""}
                  </span>
                  <span className="truncate text-xs text-(--mint-muted)">{entry.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
