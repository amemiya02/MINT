import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { useTabStore, useTabsState } from "../tabs/context.ts";
import { tabName } from "../tabs/tab-name.ts";
import { ProposedSelectionEdit } from "./ProposedSelectionEdit.tsx";

const buttonClass =
  "rounded-md border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";

export function ReplyExcerpt({
  reply,
  originName,
  originPath,
  originalText,
  onReplace,
  onUsed,
}: {
  readonly reply: string;
  readonly originName: string;
  readonly originPath: string | null;
  readonly originalText: string;
  readonly onReplace: (excerpt: string) => string | null;
  readonly onUsed?: () => void;
}) {
  const t = useT();
  const store = useTabStore();
  const { activeId, tabs } = useTabsState();
  const cursorTab = tabs.find((tab) => tab.id === activeId);
  const replyField = useRef<HTMLTextAreaElement>(null);
  const [excerpt, setExcerpt] = useState("");
  const [comparison, setComparison] = useState<{ current: string; excerpt: string } | null>(null);

  useEffect(() => {
    const field = replyField.current;
    if (!field) return;
    const select = () => setExcerpt(field.value.slice(field.selectionStart, field.selectionEnd));
    field.addEventListener("select", select);
    return () => field.removeEventListener("select", select);
  }, []);

  function insertAtCursor() {
    const current = store.getState();
    if (!cursorTab || current.activeId !== cursorTab.id) return;
    if (current.tabs.find((tab) => tab.id === cursorTab.id)?.external) return;
    const editor = store.editor(cursorTab.id);
    if (!editor) return;
    const { head } = editor.getSelection();
    editor.replaceRange({ from: head, to: head }, excerpt);
    editor.focus();
    onUsed?.();
  }

  return (
    <div className="space-y-2">
      <textarea
        ref={replyField}
        aria-label={t("writing.reply")}
        className="block w-full resize-y rounded bg-(--mint-hover) p-2 font-mono focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
        readOnly
        rows={3}
        value={reply}
      />
      <div className="flex flex-wrap gap-1">
        {cursorTab && (
          <button
            type="button"
            className={buttonClass}
            title={cursorTab.path ?? undefined}
            disabled={!excerpt || !!cursorTab.external}
            onClick={insertAtCursor}
          >
            {t("writing.reply.insert", { name: tabName(t, cursorTab) })}
          </button>
        )}
        <button
          type="button"
          className={buttonClass}
          title={originPath ?? undefined}
          disabled={!excerpt}
          onClick={() => {
            const current = onReplace(excerpt);
            setComparison(current === null ? null : { current, excerpt });
            if (current === null) onUsed?.();
          }}
        >
          {t("writing.reply.replace", { name: originName })}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!excerpt}
          onClick={() => {
            store.restoreDocument(null, excerpt);
            onUsed?.();
          }}
        >
          {t("writing.reply.newDraft")}
        </button>
      </div>
      {comparison && (
        <ProposedSelectionEdit
          before={originalText}
          after={comparison.excerpt}
          current={comparison.current}
          status="conflict"
          onDiscard={() => setComparison(null)}
        />
      )}
    </div>
  );
}
