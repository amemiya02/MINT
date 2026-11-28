import { type ClipboardEvent, type DragEvent, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import { MaterialRangeEditor } from "./MaterialRangeEditor.tsx";
import { type VisionCheck, VisionControl } from "./ModelVision.tsx";
import { materialLabel } from "./material-display.ts";
import {
  type MaterialSource,
  rangedSource,
  readMaterialText,
  sourceLines,
  usableMaterialText,
} from "./material-source.ts";
import { hasTaskImages, type NamedMaterial } from "./writing-sender.ts";
import { ZoteroMaterialPicker } from "./ZoteroMaterialPicker.tsx";

const previewClass =
  "max-h-28 overflow-auto whitespace-pre-wrap wrap-anywhere rounded bg-(--mint-hover) p-2";
const buttonClass =
  "rounded border border-(--mint-border) px-2 py-1 hover:bg-(--mint-hover) focus-visible:outline-2 disabled:opacity-50";

export interface MaterialEntry {
  readonly id: string | number;
  readonly material: NamedMaterial;
  readonly revision?: number;
  readonly tool?: "zotero";
}

interface RangeEntry {
  readonly id: number;
  readonly source: MaterialSource;
  readonly selected?: Omit<MaterialEntry, "id">;
  readonly editing: boolean;
}

export function useNamedMaterials() {
  const [entries, setEntries] = useState<readonly MaterialEntry[]>([]);
  const [ranges, setRanges] = useState<readonly RangeEntry[]>([]);
  const nextId = useRef(0);
  const generation = useRef(0);
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState(false);
  const confirmed = useMemo(
    () =>
      [
        ...entries,
        ...ranges.flatMap(({ id, editing, selected }) =>
          !editing && selected ? [{ id, ...selected }] : [],
        ),
      ].sort((first, second) => Number(first.id) - Number(second.id)),
    [entries, ranges],
  );
  const materials = confirmed.map(({ material }) => material);
  const pending = ranges.filter(({ editing }) => editing);

  return {
    entries: confirmed,
    pending,
    hasRanges: ranges.length > 0,
    hasImages: hasTaskImages({ materials }),
    loading: loading > 0,
    unconfirmed: pending.length > 0,
    error,
    isRange(id: MaterialEntry["id"]) {
      return ranges.some((range) => range.id === id);
    },
    edit(id: MaterialEntry["id"]) {
      setRanges((previous) =>
        previous.map((range) => (range.id === id ? { ...range, editing: true } : range)),
      );
    },
    accept(id: number, material: NamedMaterial) {
      const selected = { material, revision: nextId.current++ };
      setRanges((previous) =>
        previous.map((range) => (range.id === id ? { ...range, editing: false, selected } : range)),
      );
    },
    clear() {
      generation.current++;
      setError(false);
      setEntries([]);
      setRanges([]);
    },
    remove(id: MaterialEntry["id"]) {
      setEntries((previous) => previous.filter((entry) => entry.id !== id));
      setRanges((previous) => previous.filter((entry) => entry.id !== id));
    },
    paste(name: string, text: string, tool?: MaterialEntry["tool"]) {
      const valid = usableMaterialText(text);
      if (valid) {
        const entry = { id: nextId.current++, material: { name, text }, tool };
        setEntries((previous) => [...previous, entry]);
      }
      setError(!valid);
      return valid;
    },
    async read(pick: () => Promise<readonly File[]>) {
      const started = generation.current;
      setLoading((count) => count + 1);
      setError(false);
      try {
        const files = (await pick()).map((file) => ({ id: nextId.current++, file }));
        const parsed = await Promise.allSettled(
          files.map(async ({ id, file }): Promise<MaterialEntry | RangeEntry> => {
            const source = rangedSource(file);
            if (source && file.size <= 32 * 1024 * 1024) return { id, source, editing: true };
            if (source) throw new Error("invalidMaterial");
            return { id, material: { name: file.name, text: await readMaterialText(file) } };
          }),
        );
        if (generation.current !== started) return;
        const added: MaterialEntry[] = [];
        const sources: RangeEntry[] = [];
        for (const result of parsed) {
          if (result.status === "rejected") setError(true);
          else if ("source" in result.value) sources.push(result.value);
          else added.push(result.value);
        }
        if (added.length) setEntries((previous) => [...previous, ...added]);
        if (sources.length) setRanges((previous) => [...previous, ...sources]);
      } catch {
        if (generation.current === started) setError(true);
      } finally {
        setLoading((count) => count - 1);
      }
    },
  };
}

export function MaterialPreview({ material }: { readonly material: NamedMaterial }) {
  const t = useT();
  return material.image ? (
    <img
      className="max-h-36 max-w-full object-contain"
      src={material.image}
      alt={materialLabel(material, t)}
    />
  ) : (
    <pre className={previewClass}>{material.text}</pre>
  );
}

export function TaskContextChecklist({
  platform,
  named,
  recipient,
  vision,
  selection,
  draft,
  emptyDraft,
  includeDraft,
  handlingFull = true,
  folder,
  searchEnabled = false,
  onSearchChange,
}: {
  readonly platform: Platform;
  readonly named: ReturnType<typeof useNamedMaterials>;
  readonly recipient?: string;
  readonly vision?: VisionCheck;
  readonly selection?: string;
  readonly draft?: NamedMaterial;
  readonly emptyDraft?: boolean;
  readonly includeDraft?: (checked: boolean) => void;
  readonly handlingFull?: boolean;
  readonly folder?: string | null;
  readonly searchEnabled?: boolean;
  readonly onSearchChange?: (checked: boolean) => void;
}) {
  const t = useT();
  return (
    <fieldset
      className="space-y-2 rounded border border-(--mint-border) p-2 text-xs"
      {...materialDropHandlers(named)}
    >
      <legend className="px-1">
        {t(handlingFull ? "writing.context" : "materials.capacity.sources")}
      </legend>
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
                {t(handlingFull ? "materials.includeDraft" : "materials.capacity.includeDraft")}
              </label>
            )}
            {draft ? (
              <>
                <span>{draft.name}</span>{" "}
                <span>
                  {t("materials.capacity.lineCount", {
                    count: String(sourceLines(draft.text).length),
                  })}
                </span>
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
          {named.entries.map(({ id, material, tool }) => (
            <li key={id} className="flex items-start justify-between gap-2">
              <details className="min-w-0 flex-1" open={tool === "zotero" || undefined}>
                <summary className="cursor-pointer wrap-anywhere">
                  {materialLabel(material, t)}
                </summary>
                {!material.image && (
                  <p>
                    {t("materials.capacity.lineCount", {
                      count: String(sourceLines(material.text).length),
                    })}
                  </p>
                )}
                <MaterialPreview material={material} />
              </details>
              <div className="flex flex-wrap gap-1">
                {named.isRange(id) && (
                  <button type="button" className={buttonClass} onClick={() => named.edit(id)}>
                    {t("materials.edit", { name: material.name })}
                  </button>
                )}
                <button type="button" className={buttonClass} onClick={() => named.remove(id)}>
                  {t("materials.remove", { name: material.name })}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <MaterialPicker platform={platform} named={named} vision={vision} />
      {folder && onSearchChange && (
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
      event.stopPropagation();
      void named.read(async () => files);
    },
  };
}

export function MaterialPicker({
  platform,
  named,
  vision,
}: {
  readonly platform: Platform;
  readonly named: ReturnType<typeof useNamedMaterials>;
  readonly vision?: VisionCheck;
}) {
  const t = useT();
  const [pasted, setPasted] = useState("");
  return (
    <>
      {named.entries.some(({ tool }) => tool === "zotero") && (
        <dl className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{t("materials.tools")}</dt>
          <dd>{t("materials.zotero.tool")}</dd>
        </dl>
      )}
      <ZoteroMaterialPicker
        platform={platform}
        add={(name, text) => named.paste(name, text, "zotero")}
      />
      <details className="space-y-2">
        <summary className="cursor-pointer">{t("materials.add")}</summary>
        <p className="text-(--mint-muted)">{t("materials.dropHint")}</p>
        <button
          type="button"
          className={buttonClass}
          onClick={() =>
            void named.read(async () => {
              const file = await platform.pickFile(
                ".md,.markdown,.txt,.csv,.tsv,.json,text/*,.pdf,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif",
              );
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
      {named.hasRanges && vision && <VisionControl check={vision} />}
      {named.hasImages && vision?.verified !== true && (
        <p role="alert">{t("materials.visionRequired")}</p>
      )}
      {named.pending.map(({ id, source, selected }) => (
        <MaterialRangeEditor
          key={id}
          source={source}
          previous={selected?.material}
          vision={vision?.verified === true}
          onAccept={(material) => named.accept(id, material)}
          onRemove={() => named.remove(id)}
        />
      ))}
      {named.loading && <p role="status">{t("materials.reading")}</p>}
      {named.error && <p role="alert">{t("materials.invalid")}</p>}
    </>
  );
}
