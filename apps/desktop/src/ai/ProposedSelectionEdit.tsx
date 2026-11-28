import { renderHtml } from "@mint/markdown";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { useDialect } from "../settings/useDialect.ts";

export type EditStatus = "preview" | "applied" | "discarded" | "reverted";

export function ProposedSelectionEdit({
  before,
  after,
  status,
  showAppliedComparison,
  label,
  source,
  current,
  blocked,
  replyExcerpt,
  busy,
  conversation,
  recipient,
  onApply,
  onDiscard,
  onRevert,
  onRewrite,
}: {
  readonly before: string;
  readonly after: string;
  readonly status: EditStatus;
  readonly showAppliedComparison?: boolean | undefined;
  readonly label: string;
  readonly source: boolean;
  readonly current?: string | undefined;
  readonly blocked?: "disk" | "boundaries" | undefined;
  readonly replyExcerpt?: boolean;
  readonly busy?: boolean;
  readonly conversation?: ReactNode;
  readonly recipient?: string;
  readonly onApply?: (() => void) | undefined;
  readonly onDiscard?: (() => void) | undefined;
  readonly onRevert?: (() => void) | undefined;
  readonly onRewrite?: ((instruction: string) => Promise<boolean>) | undefined;
}) {
  const t = useT();
  const [rewriting, setRewriting] = useState(false);
  const [instruction, setInstruction] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (rewriting) input.current?.focus();
  }, [rewriting]);

  if (
    (status === "applied" && !showAppliedComparison) ||
    status === "discarded" ||
    status === "reverted"
  ) {
    return (
      <fieldset aria-label={label} className="min-w-0">
        <p>{t(`writing.edit.${status}`)}</p>
        <pre className="whitespace-pre-wrap wrap-anywhere">{after}</pre>
        {conversation}
      </fieldset>
    );
  }

  const comparingReversion = status === "applied" && current !== undefined;
  return (
    <fieldset
      aria-label={label}
      className="min-w-0 space-y-2 rounded border border-(--mint-border) p-2"
    >
      <legend className="px-1 text-xs font-medium">{label}</legend>
      {status === "applied" && <p>{t("writing.edit.applied")}</p>}
      {(current !== undefined || blocked) && (
        <p role="alert">
          {t(
            replyExcerpt
              ? "writing.reply.conflict"
              : status === "applied"
                ? "writing.edit.revertConflict"
                : "writing.edit.conflict",
          )}
        </p>
      )}
      {blocked && <p>{t(`writing.edit.blocked.${blocked}`)}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0 rounded bg-(--mint-diff-removed-bg) p-1">
          <p className="text-xs font-medium">
            {t(
              replyExcerpt
                ? "writing.reply.current"
                : current === undefined
                  ? "writing.edit.before"
                  : "writing.edit.current",
            )}
          </p>
          {replyExcerpt && current === "" ? (
            <p className="text-(--mint-muted)">{t("writing.reply.emptySelection")}</p>
          ) : (
            <Excerpt text={current ?? before} source={source} />
          )}
        </div>
        <div className="min-w-0 rounded bg-(--mint-diff-added-bg) p-1">
          <p className="text-xs font-medium">
            {t(
              replyExcerpt
                ? "writing.reply.selected"
                : comparingReversion
                  ? "writing.edit.before"
                  : status === "applied"
                    ? "writing.edit.appliedText"
                    : "writing.edit.after",
            )}
          </p>
          <Excerpt text={comparingReversion ? before : after} source={source} />
        </div>
      </div>
      {current !== undefined && (
        <details>
          <summary>
            {t(
              replyExcerpt
                ? "writing.reply.original"
                : comparingReversion
                  ? "writing.edit.appliedText"
                  : "writing.edit.before",
            )}
          </summary>
          <Excerpt text={comparingReversion ? after : before} source={source} />
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        {onApply && (
          <button
            type="button"
            className="rounded border border-(--mint-border) px-2 py-1"
            disabled={busy}
            onClick={onApply}
          >
            {t(current === undefined ? "writing.edit.apply" : "writing.edit.applyCompared")}
          </button>
        )}
        {onDiscard && (
          <button
            type="button"
            className="rounded border border-(--mint-border) px-2 py-1"
            disabled={busy}
            onClick={onDiscard}
          >
            {t(replyExcerpt ? "writing.reply.dismissComparison" : "writing.edit.discard")}
          </button>
        )}
        {onRevert && (
          <button
            type="button"
            className="rounded border border-(--mint-border) px-2 py-1"
            disabled={busy}
            onClick={onRevert}
          >
            {t(comparingReversion ? "writing.edit.revertCompared" : "writing.edit.revert")}
          </button>
        )}
        {onRewrite && !rewriting && (
          <button
            type="button"
            className="rounded border border-(--mint-border) px-2 py-1"
            disabled={busy}
            onClick={() => setRewriting(true)}
          >
            {t("writing.edit.rewrite")}
          </button>
        )}
      </div>
      {rewriting && onRewrite && recipient && (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!instruction.trim() || busy) return;
            if (await onRewrite(instruction.trim())) {
              setRewriting(false);
              setInstruction("");
            }
          }}
        >
          <p className="text-xs text-(--mint-muted)">
            {t("writing.edit.rewriteContext", { recipient })}
          </p>
          <label className="grid gap-1">
            {t("writing.edit.rewriteInstruction")}
            <input
              ref={input}
              className="rounded border border-(--mint-border) px-2 py-1"
              value={instruction}
              disabled={busy}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="rounded border border-(--mint-border) px-2 py-1"
            disabled={busy || !instruction.trim()}
          >
            {t("writing.edit.sendRewrite")}
          </button>
        </form>
      )}
      {conversation}
    </fieldset>
  );
}

function Excerpt({ text, source }: { readonly text: string; readonly source: boolean }) {
  const t = useT();
  const dialect = useDialect();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (source || !ref.current) return;
    try {
      const template = document.createElement("template");
      template.innerHTML = renderHtml(text, dialect);
      for (const node of template.content.querySelectorAll("[src], [srcset], a[href]")) {
        node.removeAttribute("src");
        node.removeAttribute("srcset");
        node.removeAttribute("href");
      }
      ref.current.replaceChildren(template.content);
    } catch {
      ref.current.textContent = text;
    }
  }, [dialect, source, text]);

  return text === "" ? (
    <span className="text-(--mint-muted)">{t("writing.edit.empty")}</span>
  ) : source ? (
    <pre className="whitespace-pre-wrap wrap-anywhere">{text}</pre>
  ) : (
    <div ref={ref} className="mint-document mint-link-preview wrap-anywhere" />
  );
}
