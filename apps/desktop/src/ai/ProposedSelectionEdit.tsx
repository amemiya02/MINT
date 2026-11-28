import { renderHtml } from "@mint/markdown";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { useDialect } from "../settings/useDialect.ts";

export type EditStatus = "preview" | "applied" | "discarded" | "conflict";

export function ProposedSelectionEdit({
  before,
  after,
  status,
  onApply,
  onDiscard,
}: {
  readonly before: string;
  readonly after: string;
  readonly status: EditStatus;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
}) {
  const t = useT();
  const [source, setSource] = useState(false);
  if (status === "applied" || status === "discarded") {
    return (
      <div>
        <p>{t(`writing.edit.${status}`)}</p>
        <pre className="whitespace-pre-wrap wrap-anywhere">{after}</pre>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded border border-(--mint-border) p-2">
      {status === "conflict" && <p role="alert">{t("writing.edit.conflict")}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">{t("writing.edit.before")}</p>
          <Excerpt text={before} source={source} />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium">{t("writing.edit.after")}</p>
          <Excerpt text={after} source={source} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={source}
            onChange={(event) => setSource(event.target.checked)}
          />
          {t("writing.edit.source")}
        </label>
        {status === "preview" && (
          <button
            type="button"
            className="rounded border border-(--mint-border) px-2 py-1"
            onClick={onApply}
          >
            {t("writing.edit.apply")}
          </button>
        )}
        <button
          type="button"
          className="rounded border border-(--mint-border) px-2 py-1"
          onClick={onDiscard}
        >
          {t("writing.edit.discard")}
        </button>
      </div>
    </div>
  );
}

function Excerpt({ text, source }: { readonly text: string; readonly source: boolean }) {
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

  return source ? (
    <pre className="whitespace-pre-wrap wrap-anywhere">{text}</pre>
  ) : (
    <div ref={ref} className="mint-document mint-link-preview wrap-anywhere" />
  );
}
