import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { useTabStore } from "./context.ts";
import { diffLines } from "./line-diff.ts";
import { tabName } from "./tab-name.ts";
import type { Tab } from "./tab-store.ts";

const buttonClass =
  "shrink-0 rounded-md border border-current/30 px-3 py-0.5 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)";

/** Tells the user that another program changed, deleted or moved the tab's document. */
export function ExternalChangeNotice({ tab }: { readonly tab: Tab }) {
  const t = useT();
  const store = useTabStore();
  const [comparing, setComparing] = useState(false);
  const { external } = tab;
  if (!external) return null;
  const name = tabName(t, tab);

  return (
    <>
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-(--mint-border) bg-(--mint-notice-bg) px-4 py-2 text-sm text-(--mint-notice-fg)"
      >
        {external.kind === "conflict" ? (
          <>
            <span>{t("external.conflict", { name })}</span>
            <span className="flex gap-2">
              <button
                type="button"
                className={buttonClass}
                onClick={() => store.resolveConflict(tab.id, "keepMine")}
              >
                {t("external.keepMine")}
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => store.resolveConflict(tab.id, "loadDisk")}
              >
                {t("external.loadDisk")}
              </button>
              <button type="button" className={buttonClass} onClick={() => setComparing(true)}>
                {t("external.compare")}
              </button>
            </span>
          </>
        ) : (
          <>
            <span>{t("external.missing", { name })}</span>
            <span className="flex gap-2">
              <button type="button" className={buttonClass} onClick={() => void store.save(tab.id)}>
                {t("external.save")}
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => store.dismissExternal(tab.id)}
              >
                {t("external.dismiss")}
              </button>
            </span>
          </>
        )}
      </div>
      {comparing && external.kind === "conflict" && (
        <CompareDialog
          name={name}
          local={store.getText(tab.id) ?? ""}
          disk={external.diskText}
          onChoose={(choice) => store.resolveConflict(tab.id, choice)}
          onClose={() => setComparing(false)}
        />
      )}
    </>
  );
}

interface CompareDialogProps {
  readonly name: string;
  readonly local: string;
  readonly disk: string;
  readonly onChoose: (choice: "keepMine" | "loadDisk") => void;
  readonly onClose: () => void;
}

/** Line-by-line differences between the tab's text (removed) and the disk (added). */
function CompareDialog({ name, local, disk, onChoose, onClose }: CompareDialogProps) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const lines = useMemo(() => diffLines(local, disk), [local, disk]);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const choose = (choice: "keepMine" | "loadDisk") => {
    dialog.current?.close();
    onChoose(choice);
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto flex max-h-[80vh] w-[min(48rem,calc(100%-2rem))] flex-col rounded-lg border border-(--mint-border) bg-(--mint-bg) p-0 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <div className="border-b border-(--mint-border) px-5 py-3">
        <h2 id={titleId} className="text-base font-medium">
          {t("external.compare.title")}
        </h2>
        <p className="text-xs text-(--mint-muted)">{t("external.compare.legend", { name })}</p>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto px-5 py-3 font-(family-name:--mint-font-editor) text-sm leading-relaxed">
        {lines.map((line, i) => {
          const key = `${i}`;
          if (line.kind === "removed")
            return (
              <del key={key} className="block bg-(--mint-diff-removed-bg) no-underline">
                {`- ${line.text}`}
              </del>
            );
          if (line.kind === "added")
            return (
              <ins key={key} className="block bg-(--mint-diff-added-bg) no-underline">
                {`+ ${line.text}`}
              </ins>
            );
          return <span key={key} className="block">{`  ${line.text}`}</span>;
        })}
      </pre>
      <div className="flex justify-end gap-2 border-t border-(--mint-border) px-5 py-3 text-sm">
        <button
          type="button"
          className="rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
          onClick={() => dialog.current?.close()}
        >
          {t("external.compare.close")}
        </button>
        <button
          type="button"
          className="rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
          onClick={() => choose("keepMine")}
        >
          {t("external.keepMine")}
        </button>
        <button
          type="button"
          className="rounded-md border border-(--mint-border) px-3 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
          onClick={() => choose("loadDisk")}
        >
          {t("external.loadDisk")}
        </button>
      </div>
    </dialog>
  );
}
