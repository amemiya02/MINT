import { useT } from "../i18n/index.ts";
import { relativePath } from "../paths.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import type { MovePreview } from "./move-links.ts";

export function MoveDialog({
  preview,
  folder,
  onChoose,
  onClose,
}: {
  preview: MovePreview;
  folder: string;
  onChoose: (update: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  return (
    <dialog
      {...props}
      aria-label={t("move.preview")}
      className="m-auto w-[min(42rem,95vw)] max-h-[85vh] overflow-auto rounded-lg border border-(--mint-border) bg-(--mint-bg) p-5 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <h2 className="text-lg font-medium">{t("move.preview")}</h2>
      <ul className="my-4 space-y-2 text-sm">
        {preview.references.map((ref) => (
          <li key={JSON.stringify([ref.path, ref.line, ref.column])}>
            <strong>
              {relativePath(folder, ref.path)} · {ref.line}:{ref.column}
            </strong>
            <div>{ref.context}</div>
            <code>→ {ref.destination}</code>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-4">
        <button type="button" onClick={close}>
          {t("unsaved.cancel")}
        </button>
        <button type="button" onClick={() => onChoose(false)}>
          {t("move.only")}
        </button>
        <button type="button" onClick={() => onChoose(true)}>
          {t("move.update")}
        </button>
      </div>
    </dialog>
  );
}
