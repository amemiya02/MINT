import { useId } from "react";
import { useT } from "../i18n/index.ts";
import { useModalDialog } from "../window/useModalDialog.ts";

const button =
  "rounded-md border border-(--mint-border) bg-(--mint-bg) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent) disabled:opacity-50";

export function TemporarySessionClose({
  busy,
  closing,
  failed,
  onCancel,
  onReview,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly closing: boolean;
  readonly failed: boolean;
  readonly onCancel: () => void;
  readonly onReview?: () => void;
  readonly onConfirm: () => void;
}) {
  const t = useT();
  const { props, close } = useModalDialog(onCancel);
  const description = useId();
  return (
    <dialog
      {...props}
      onCancel={(event) => {
        if (closing) event.preventDefault();
        else props.onCancel(event);
      }}
      aria-label={t("writing.temporary.close")}
      aria-describedby={description}
      className="m-auto max-h-[85vh] w-[min(28rem,90vw)] space-y-3 overflow-auto rounded-lg border border-(--mint-border) bg-(--mint-bg) p-4 text-(--mint-fg) backdrop:bg-black/30"
    >
      <h2 className="font-medium">{t("writing.temporary.close")}</h2>
      <p id={description}>{t("writing.temporary.closePrompt")}</p>
      {busy && <p>{t("writing.temporary.wait")}</p>}
      {failed && <p role="alert">{t("writing.temporary.cleanupFailed")}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={closing} onClick={close}>
          {t("unsaved.cancel")}
        </button>
        {onReview && (
          <button type="button" className={button} disabled={closing} onClick={onReview}>
            {t("writing.viewChanges")}
          </button>
        )}
        <button type="button" className={button} disabled={busy || closing} onClick={onConfirm}>
          {t("writing.temporary.close")}
        </button>
      </div>
    </dialog>
  );
}
