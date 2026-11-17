import type { EditorMode, WordCount } from "@mint/editor";
import { useT } from "../i18n/index.ts";
import type { Tab } from "../tabs/tab-store.ts";

/** The line under the editor: the active document's name, word count, mode and save state. */
export function StatusBar(props: {
  readonly tab: Tab;
  readonly name: string;
  readonly mode: EditorMode;
  readonly wordCount: WordCount | null;
}) {
  const t = useT();
  const { tab, name, mode, wordCount } = props;
  return (
    <footer className="flex items-center justify-between border-t border-(--mint-border) px-4 py-1 text-xs text-(--mint-muted)">
      <span title={tab.path ?? undefined}>{name}</span>
      <span className="flex gap-4">
        {wordCount && <WordCountStatus count={wordCount} />}
        <span>{t(mode === "source" ? "status.mode.source" : "status.mode.livePreview")}</span>
        <span>{t(tab.dirty ? "status.unsaved" : "status.saved")}</span>
      </span>
    </footer>
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
