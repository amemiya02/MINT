import { type ClipboardEvent, type DragEvent, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import type { NamedMaterial } from "./writing-sender.ts";

const materialLimit = 64 * 1024;
const encoder = new TextEncoder();
const previewClass =
  "max-h-28 overflow-auto whitespace-pre-wrap wrap-anywhere rounded bg-(--mint-hover) p-2";
const buttonClass =
  "rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 disabled:opacity-50";

export interface MaterialEntry {
  readonly id: string | number;
  readonly material: NamedMaterial;
}

function checkedMaterial(name: string, text: string): NamedMaterial {
  // Only accept UTF-8 text with ordinary whitespace, and refuse oversize input without truncating.
  if (encoder.encode(text).length > materialLimit || !text.trim() || /[^\P{Cc}\t\n\r]/u.test(text))
    throw new Error("invalidMaterial");
  return { name, text };
}

export function useNamedMaterials() {
  const [entries, setEntries] = useState<readonly MaterialEntry[]>([]);
  const nextId = useRef(0);
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState(false);
  function add(materials: readonly NamedMaterial[]) {
    const added = materials.map((material) => ({ id: nextId.current++, material }));
    setEntries((previous) => [...previous, ...added]);
  }

  return {
    entries,
    materials: entries.map(({ material }) => material),
    loading: loading > 0,
    error,
    remove(id: MaterialEntry["id"]) {
      setEntries((previous) => previous.filter((entry) => entry.id !== id));
    },
    paste(name: string, text: string) {
      try {
        add([checkedMaterial(name, text)]);
        setError(false);
        return true;
      } catch {
        setError(true);
        return false;
      }
    },
    async read(pick: () => Promise<readonly File[]>) {
      setLoading((count) => count + 1);
      setError(false);
      try {
        const files = await pick();
        const added = await Promise.allSettled(
          files.map(async (file) => {
            if (file.size > materialLimit) throw new Error("invalidMaterial");
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              await file.arrayBuffer(),
            );
            return checkedMaterial(file.name, text);
          }),
        );
        add(added.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])));
        if (added.some((result) => result.status === "rejected")) setError(true);
      } catch {
        setError(true);
      } finally {
        setLoading((count) => count - 1);
      }
    },
  };
}

export function TaskContextChecklist({
  platform,
  named,
  recipient,
  selection,
  draft,
  emptyDraft,
  includeDraft,
  folder,
  searchEnabled,
  onSearchChange,
}: {
  readonly platform: Platform;
  readonly named: ReturnType<typeof useNamedMaterials>;
  readonly recipient?: string;
  readonly selection?: string;
  readonly draft?: NamedMaterial;
  readonly emptyDraft?: boolean;
  readonly includeDraft?: (checked: boolean) => void;
  readonly folder: string | null;
  readonly searchEnabled: boolean;
  readonly onSearchChange: (checked: boolean) => void;
}) {
  const t = useT();
  return (
    <fieldset
      className="space-y-2 rounded border border-(--mint-border) p-2 text-xs"
      {...materialDropHandlers(named)}
    >
      <legend className="px-1">{t("writing.context")}</legend>
      <dl className="space-y-1 wrap-anywhere">
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{t("writing.recipient")}</dt>
          <dd>{recipient ?? t("writing.chooseRecipient")}</dd>
        </div>
        <div>
          <dt className="font-medium">{t("writing.scope.selection")}</dt>
          <dd>
            {selection === undefined ? (
              t("materials.noSelection")
            ) : (
              <pre className={previewClass}>{selection}</pre>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-medium">{t("materials.currentDraft")}</dt>
          <dd>
            {includeDraft && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={!!draft}
                  onChange={(event) => includeDraft(event.target.checked)}
                />
                {t("materials.includeDraft")}
              </label>
            )}
            {draft ? (
              <>
                <span>{draft.name}</span>
                <pre className={previewClass}>{draft.text}</pre>
              </>
            ) : !includeDraft ? (
              t(emptyDraft ? "materials.emptyDraft" : "materials.excluded")
            ) : null}
          </dd>
        </div>
      </dl>
      {named.entries.length > 0 && (
        <ul className="space-y-1">
          {named.entries.map(({ id, material: { name, text } }) => (
            <li key={id} className="flex items-start justify-between gap-2">
              <details className="min-w-0 flex-1">
                <summary className="cursor-pointer wrap-anywhere">{name}</summary>
                <pre className={previewClass}>{text}</pre>
              </details>
              <button type="button" className={buttonClass} onClick={() => named.remove(id)}>
                {t("materials.remove", { name })}
              </button>
            </li>
          ))}
        </ul>
      )}
      <MaterialPicker platform={platform} named={named} />
      {folder && (
        <div className="wrap-anywhere">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={searchEnabled}
              onChange={(event) => onSearchChange(event.target.checked)}
            />
            {t("materials.allowSearch")}
          </label>
          <p className="text-(--mint-muted)">{folder}</p>
        </div>
      )}
    </fieldset>
  );
}

export function materialDropHandlers(named: ReturnType<typeof useNamedMaterials>) {
  return {
    onDragOver(event: DragEvent<HTMLElement>) {
      if (event.dataTransfer.types.includes("Files")) event.preventDefault();
    },
    onDrop(event: DragEvent<HTMLElement>) {
      const files = Array.from(event.dataTransfer.files);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.currentTarget.matches(":disabled")) void named.read(async () => files);
    },
    onPaste(event: ClipboardEvent<HTMLElement>) {
      const files = Array.from(event.clipboardData.files);
      if (!files.length || event.currentTarget.matches(":disabled")) return;
      event.preventDefault();
      void named.read(async () => files);
    },
  };
}

export function MaterialPicker({
  platform,
  named,
}: {
  readonly platform: Platform;
  readonly named: ReturnType<typeof useNamedMaterials>;
}) {
  const t = useT();
  const [pasted, setPasted] = useState("");
  return (
    <>
      <details className="space-y-2">
        <summary className="cursor-pointer">{t("materials.add")}</summary>
        <p className="text-(--mint-muted)">{t("materials.dropHint")}</p>
        <button
          type="button"
          className={buttonClass}
          onClick={() =>
            void named.read(async () => {
              const file = await platform.pickFile(".md,.markdown,.txt,.csv,.tsv,.json,text/*");
              return file ? [file] : [];
            })
          }
        >
          {t("materials.chooseFile")}
        </button>
        <label className="grid gap-1">
          {t("materials.pasted")}
          <textarea
            className="rounded border border-(--mint-border) bg-(--mint-bg) p-1"
            rows={2}
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={buttonClass}
          disabled={!pasted.trim()}
          onClick={() => {
            if (named.paste(t("materials.pastedName"), pasted)) setPasted("");
          }}
        >
          {t("materials.addPasted")}
        </button>
      </details>
      {named.loading && <p role="status">{t("materials.reading")}</p>}
      {named.error && <p role="alert">{t("materials.invalid")}</p>}
    </>
  );
}
