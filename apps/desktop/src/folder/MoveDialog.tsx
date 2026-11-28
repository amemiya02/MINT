import { useState } from "react";
import { useT } from "../i18n/index.ts";
import { relativePath } from "../paths.ts";
import type { DocumentEdit } from "../platform/platform.ts";
import { useModalDialog } from "../window/useModalDialog.ts";
import { type MovePreview, moveEdits, selectedOption, type TargetChoices } from "./move-links.ts";

export function MoveDialog({
  preview,
  folder,
  onChoose,
  onClose,
}: {
  preview: MovePreview;
  folder: string;
  onChoose: (edits: DocumentEdit[], updateLinks: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { props, close } = useModalDialog(onClose);
  const [choices, setChoices] = useState<TargetChoices>(new Map());
  const ready = preview.documents.every(({ references }) =>
    references.every((reference) => {
      const option = selectedOption(reference, choices);
      return option && !option.unavailable;
    }),
  );
  return (
    <dialog
      {...props}
      aria-label={t("move.preview")}
      className="m-auto w-[min(42rem,95vw)] max-h-[85vh] overflow-auto rounded-lg border border-(--mint-border) bg-(--mint-bg) p-5 text-(--mint-fg) shadow-xl backdrop:bg-black/30"
    >
      <h2 className="text-lg font-medium">{t("move.preview")}</h2>
      <ul className="my-4 space-y-2 text-sm">
        {preview.documents.flatMap(({ path, references }) =>
          references.map((reference) => {
            const { ref, options } = reference;
            const location = `${relativePath(folder, path)} · ${ref.line}:${ref.column}`;
            const option = selectedOption(reference, choices);
            return (
              <li key={JSON.stringify([path, ref.from])}>
                <strong>{location}</strong>
                <div>{ref.context}</div>
                {options.length > 1 && (
                  <label className="flex gap-2 items-center">
                    {t("move.target")}
                    <select
                      aria-label={`${t("move.target")} · ${location}`}
                      className="border border-(--mint-border) bg-(--mint-bg)"
                      value={option?.path ?? ""}
                      onChange={(event) => {
                        const path = event.currentTarget.value;
                        setChoices((previous) => new Map(previous).set(ref, path));
                      }}
                    >
                      <option value="">{t("move.chooseTarget")}</option>
                      {options.map(({ path }) => (
                        <option value={path} key={path}>
                          {relativePath(folder, path)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {option &&
                  (option.unavailable ? (
                    <p>{t("move.unavailable")}</p>
                  ) : option.replacement === null ? (
                    <p>{t("move.keep")}</p>
                  ) : (
                    <code>→ {option.replacement}</code>
                  ))}
              </li>
            );
          }),
        )}
      </ul>
      <div className="flex flex-wrap justify-end gap-4">
        <button type="button" onClick={close}>
          {t("unsaved.cancel")}
        </button>
        <button type="button" onClick={() => onChoose([preview.moveOnly], false)}>
          {t("move.only")}
        </button>
        <button
          type="button"
          className="disabled:opacity-50"
          disabled={!ready}
          onClick={() => onChoose(moveEdits(preview, choices), true)}
        >
          {t("move.update")}
        </button>
      </div>
    </dialog>
  );
}
