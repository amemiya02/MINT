import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { useTabStore, useTabsState } from "../tabs/context.ts";
import { tabName } from "../tabs/tab-name.ts";
import { ProposedSelectionEdit } from "./ProposedSelectionEdit.tsx";
import { applyWritingSelection, type WritingSelection } from "./writing-selection.ts";

const buttonClass =
  "rounded-md border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";

export function ReplyExcerpt({
  reply,
  origin,
  originId,
  onUsed,
}: {
  readonly reply: string;
  readonly origin: WritingSelection;
  readonly originId: number;
  readonly onUsed?: () => void;
}) {
  const t = useT();
  const store = useTabStore();
  const { activeId, tabs } = useTabsState();
  const cursorTab = tabs.find((tab) => tab.id === activeId);
  const originTab = tabs.find((tab) => tab.id === originId);
  const replyField = useRef<HTMLTextAreaElement>(null);
  const [excerpt, setExcerpt] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [showSource, setShowSource] = useState(false);
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

  async function replaceOriginal() {
    setReplacing(true);
    try {
      const fresh = await store.refreshDisk(originId);
      if (!replyField.current || store.editor(originId) !== origin.editor) return;
      const result = applyWritingSelection(origin, excerpt, fresh);
      if (result.status === "conflict") {
        setComparison({ current: result.current, excerpt });
      } else {
        setComparison(null);
        origin.editor.focus();
        onUsed?.();
      }
    } finally {
      setReplacing(false);
    }
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
            disabled={!excerpt || replacing || !!cursorTab.external}
            onClick={insertAtCursor}
          >
            {t("writing.reply.insert", { name: tabName(t, cursorTab) })}
          </button>
        )}
        {originTab && (
          <button
            type="button"
            className={buttonClass}
            title={originTab.path ?? undefined}
            disabled={!excerpt || replacing}
            onClick={() => void replaceOriginal()}
          >
            {t("writing.reply.replace", { name: tabName(t, originTab) })}
          </button>
        )}
        <button
          type="button"
          className={buttonClass}
          disabled={!excerpt || replacing}
          onClick={() => {
            store.restoreDocument(null, excerpt);
            onUsed?.();
          }}
        >
          {t("writing.reply.newDraft")}
        </button>
      </div>
      {comparison && (
        <>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showSource}
              onChange={(event) => setShowSource(event.target.checked)}
            />
            {t("writing.edit.source")}
          </label>
          <ProposedSelectionEdit
            before={origin.text}
            after={comparison.excerpt}
            current={comparison.current}
            label={t("writing.reply.compare")}
            source={showSource}
            status="preview"
            replyExcerpt
            onDiscard={() => setComparison(null)}
          />
        </>
      )}
    </div>
  );
}
