import type { EditorMode, WordCount } from "@mint/editor";
import { useSyncExternalStore } from "react";
import { useT } from "../i18n/index.ts";
import { useTabStore } from "../tabs/context.ts";
import type { Tab } from "../tabs/tab-store.ts";

/** The line under the editor: the active document's name, word count, mode and save state. */
export function StatusBar(props: {
  readonly tab: Tab;
  readonly name: string;
  readonly openHistory: () => void;
  readonly addAnnotation: () => void;
  readonly toggleAnnotations: () => void;
  readonly annotationsOpen: boolean;
  readonly mode: EditorMode;
  readonly wordCount: WordCount | null;
}) {
  const t = useT();
  const { tab, name, mode, wordCount } = props;
  const store = useTabStore();
  const review = tab.document.review;
  const changes = useSyncExternalStore(review.subscribe, review.getSnapshot);
  return (
    <>
      {changes && (
        <section
          aria-label={t("review.heading")}
          className="max-h-48 overflow-auto border-t border-(--mint-border) px-4 py-2 text-sm"
        >
          <h2 className="font-medium">{t("review.heading")}</h2>
          {changes.length === 0 && <p className="text-(--mint-muted)">{t("review.empty")}</p>}
          {changes.map((change) => (
            <div key={change.from} className="flex items-baseline gap-2 py-1">
              <button
                type="button"
                className="shrink-0 text-(--mint-muted) hover:underline"
                onClick={() => {
                  const editor = store.editor(tab.id);
                  editor?.setSelection({
                    anchor: change.from,
                    head: change.to,
                    scrollIntoView: true,
                  });
                  editor?.focus();
                }}
              >
                {t("review.location", { line: String(change.line), column: String(change.column) })}
              </button>
              <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                {change.before && (
                  <del className="bg-(--mint-diff-removed-bg)">{change.before}</del>
                )}
                {change.after && <ins className="bg-(--mint-diff-added-bg)">{change.after}</ins>}
              </div>
              <button
                type="button"
                className="rounded border px-2"
                onClick={() => review.accept(change)}
              >
                {t("review.accept")}
              </button>
              <button
                type="button"
                className="rounded border px-2"
                onClick={() => {
                  const editor = store.editor(tab.id);
                  if (editor) review.reject(change, editor);
                }}
              >
                {t("review.reject")}
              </button>
            </div>
          ))}
        </section>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-x-4 border-t border-(--mint-border) px-4 py-1 text-xs text-(--mint-muted)">
        <span title={tab.path ?? undefined}>{name}</span>
        <span className="flex flex-wrap gap-x-4">
          <button
            type="button"
            className="hover:underline"
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.addAnnotation}
          >
            {t("command.edit.addAnnotation")}
          </button>
          <button
            type="button"
            className="hover:underline"
            aria-expanded={props.annotationsOpen}
            onClick={props.toggleAnnotations}
          >
            {t("command.view.annotations")}
          </button>
          <button
            type="button"
            className="hover:underline"
            onClick={() => {
              if (changes) review.stop();
              else review.start();
              store.editor(tab.id)?.focus();
            }}
          >
            {t(changes ? (changes.length ? "review.keepAndStop" : "review.stop") : "review.start")}
          </button>
          {wordCount && <WordCountStatus count={wordCount} />}
          <span>{t(mode === "source" ? "status.mode.source" : "status.mode.livePreview")}</span>
          {tab.path ? (
            <button
              type="button"
              title={t("command.file.history")}
              aria-label={t("command.file.history")}
              className="hover:underline"
              onClick={props.openHistory}
            >
              {t(tab.dirty ? "status.unsaved" : "status.saved")}
            </button>
          ) : (
            <span>{t(tab.dirty ? "status.unsaved" : "status.saved")}</span>
          )}
        </span>
      </footer>
    </>
  );
}

/** Words, characters and reading time of the active document; Chinese counts per character. */
function WordCountStatus({ count }: { readonly count: WordCount }) {
  const t = useT();
  const plural = (key: "status.words" | "status.characters", n: number) =>
    n === 1 ? t(`${key}.one`) : t(`${key}.other`, { count: String(n) });
  return (
    <>
      <span>{plural("status.words", count.words)}</span>
      <span>{plural("status.characters", count.characters)}</span>
      <span>{t("status.readingTime", { minutes: String(count.readingMinutes) })}</span>
    </>
  );
}
