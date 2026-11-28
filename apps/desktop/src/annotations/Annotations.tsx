import type { Annotation, AnnotationTarget, SharedDocument } from "@mint/editor";
import { useState, useSyncExternalStore } from "react";
import { useT } from "../i18n/index.ts";
import { useModalDialog } from "../window/useModalDialog.ts";

export function AnnotationDialog({
  target,
  onClose,
  onSave,
}: {
  readonly target: AnnotationTarget;
  readonly onClose: () => void;
  readonly onSave: (note: string) => void;
}) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  const [note, setNote] = useState("");
  return (
    <dialog
      {...props}
      aria-label={t("command.edit.addAnnotation")}
      className="m-auto max-h-[85vh] w-[min(30rem,95vw)] overflow-auto rounded-lg border border-(--mint-border) bg-(--mint-bg) p-5 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!note.trim()) return;
          onSave(note.trim());
          close();
        }}
      >
        <h2 className="font-medium">{t("command.edit.addAnnotation")}</h2>
        <Excerpt target={target} />
        <label className="flex flex-col gap-1 text-sm">
          {t("annotations.note")}
          <textarea
            autoFocus
            rows={4}
            className="rounded border border-(--mint-border) px-2 py-1"
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        <div className="flex justify-end gap-2 text-sm">
          <button
            type="button"
            className="rounded px-3 py-1 hover:bg-(--mint-hover)"
            onClick={close}
          >
            {t("annotations.cancel")}
          </button>
          <button
            type="submit"
            disabled={!note.trim()}
            className="rounded border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) disabled:opacity-50"
          >
            {t("annotations.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Excerpt({ target }: { readonly target: Pick<Annotation, "kind" | "excerpt"> }) {
  const t = useT();
  return (
    <div className="min-w-0">
      <span className="text-xs text-(--mint-muted)">{t(`annotations.kind.${target.kind}`)}</span>
      <blockquote className="max-h-28 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] border-s-2 border-(--mint-border) ps-2 text-sm">
        {target.excerpt || t("annotations.emptyCell")}
      </blockquote>
    </div>
  );
}

export function AnnotationPanel({
  annotations,
  onClose,
  onReveal,
}: {
  readonly annotations: SharedDocument["annotations"];
  readonly onClose: () => void;
  readonly onReveal: (item: Annotation) => void;
}) {
  const t = useT();
  const items = useSyncExternalStore(annotations.subscribe, annotations.getSnapshot);
  const groups = {
    pending: items.filter((item) => item.range && !item.resolved),
    resolved: items.filter((item) => item.range && item.resolved),
    lost: items.filter((item) => !item.range),
  };
  return (
    <aside
      aria-label={t("command.view.annotations")}
      className="max-h-52 min-w-0 overflow-auto border-t border-(--mint-border) p-3 text-sm md:max-h-none md:w-72 md:shrink-0 md:border-s md:border-t-0"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">{t("command.view.annotations")}</h2>
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-(--mint-hover)"
          onClick={onClose}
        >
          {t("annotations.close")}
        </button>
      </div>
      {items.length === 0 && <p className="text-(--mint-muted)">{t("annotations.empty")}</p>}
      {(["pending", "resolved", "lost"] as const).map((status) => (
        <section key={status} aria-label={t(`annotations.${status}`)} className="mt-3">
          <h3 className="border-b border-(--mint-border) pb-1 text-xs font-medium">
            {t(`annotations.${status}`)}
          </h3>
          <ul>
            {groups[status].map((item) => (
              <li key={item.id} className="space-y-2 border-b border-(--mint-border) py-2">
                <Excerpt target={item} />
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{item.note}</p>
                <div className="flex flex-wrap gap-3 text-xs">
                  {item.range && (
                    <>
                      <button type="button" className="underline" onClick={() => onReveal(item)}>
                        {t("annotations.reveal")}
                      </button>
                      <button
                        type="button"
                        className="underline"
                        onClick={() => annotations.setResolved(item.id, !item.resolved)}
                      >
                        {t(item.resolved ? "annotations.reopen" : "annotations.resolve")}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
