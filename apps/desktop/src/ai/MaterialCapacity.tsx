import { markdownHeadings } from "@mint/markdown";
import { useMemo, useState } from "react";
import { useT } from "../i18n/index.ts";
import { materialLabel } from "./material-display.ts";
import { sourceLines } from "./material-source.ts";
import { type MaterialEntry, MaterialPreview } from "./TaskContext.tsx";
import {
  contextMaterials,
  type NamedMaterial,
  type TaskContext,
  type WritingRequest,
} from "./writing-sender.ts";

const encoder = new TextEncoder();

export function materialBytes({
  selectedText,
  taskContext,
}: Pick<WritingRequest, "selectedText" | "taskContext">) {
  return (
    encoder.encode(selectedText ?? "").length +
    contextMaterials(taskContext).reduce(
      (total, { text, image }) => total + encoder.encode(text).length + (image?.length ?? 0),
      0,
    )
  );
}

interface LineRange {
  readonly first: string;
  readonly last: string;
}

type MaterialHandling = "full" | "excerpt" | "batch" | "summary";

export interface MaterialPlan {
  readonly method: MaterialHandling;
  readonly limit?: number;
  readonly selectedText?: string;
  readonly contexts: readonly (TaskContext | undefined)[];
}

const initialRange: LineRange = { first: "1", last: "" };
const maxBatches = 100;
const fieldClass = "rounded border border-(--mint-border) bg-(--mint-bg) p-1";

function passageLabel(
  t: ReturnType<typeof useT>,
  name: string,
  headings: ReturnType<typeof markdownHeadings>,
  first: number,
  last: number,
  location = t("materials.capacity.lines", { first: String(first), last: String(last) }),
) {
  const preceding = headings.findLast(({ line }) => line <= first);
  const sections = headings.filter(({ line }) => line > first && line <= last);
  return [name, location, preceding?.text, ...sections.map(({ text }) => text)]
    .filter(Boolean)
    .join(" · ");
}

function batchSource(t: ReturnType<typeof useT>, material: NamedMaterial, room: number) {
  const { name, text, image } = material;
  if (image) return image.length <= room ? [material] : undefined;
  const batches: NamedMaterial[] = [];
  const headings = markdownHeadings(text);
  let first = 1;
  let current: string[] = [];
  let bytes = 0;

  function flush(last: number) {
    if (!current.length) return;
    batches.push({
      ...material,
      name: passageLabel(t, name, headings, first, last),
      text: current.join(""),
    });
    current = [];
    bytes = 0;
  }

  const lines = sourceLines(text);
  for (const [index, line] of lines.entries()) {
    const size = encoder.encode(line).length;
    if (bytes + size > room) flush(index);
    if (batches.length >= maxBatches) return;
    if (size <= room) {
      if (!current.length) first = index + 1;
      current.push(line);
      bytes += size;
      continue;
    }

    // A long line still has an exact range. Keep each Unicode scalar and CRLF intact.
    let segment: string[] = [];
    let start = 1;
    let end = 0;
    const addSegment = () => {
      const location = t("materials.capacity.columns", {
        line: String(index + 1),
        first: String(start),
        last: String(end),
      });
      batches.push({
        ...material,
        name: passageLabel(t, name, headings, index + 1, index + 1, location),
        text: segment.join(""),
      });
      start = end + 1;
      segment = [];
      bytes = 0;
    };
    for (const match of line.matchAll(/\r\n|[\s\S]/gu)) {
      const character = match[0];
      const size = encoder.encode(character).length;
      if (size > room || batches.length >= maxBatches) return;
      if (bytes + size > room) addSegment();
      segment.push(character);
      bytes += size;
      end++;
    }
    addSegment();
  }
  flush(lines.length);
  return batches.length <= maxBatches ? batches : undefined;
}

export function useMaterialCapacity({
  recipient,
  selectedText,
  draft,
  entries,
  folderSearch,
  editing = false,
}: {
  readonly recipient?: string;
  readonly selectedText?: string;
  readonly draft?: NamedMaterial;
  readonly entries: readonly MaterialEntry[];
  readonly folderSearch: boolean;
  readonly editing?: boolean;
}) {
  const t = useT();
  const [chosenMethod, setMethod] = useState<MaterialHandling>("full");
  const [limitInput, setLimit] = useState("");
  const [ranges, setRanges] = useState<ReadonlyMap<MaterialEntry["id"], LineRange>>(new Map());
  const [summaries, setSummaries] = useState<ReadonlyMap<MaterialEntry["id"], string>>(new Map());
  const [rejected, setRejected] = useState<ReadonlySet<string>>(new Set());
  const draftName = draft?.name;
  const draftText = draft?.text;
  const selectionName = t("writing.scope.selection");
  const sources = useMemo<readonly MaterialEntry[]>(
    () =>
      [
        ...(!editing && selectedText
          ? [{ id: "selection", material: { name: selectionName, text: selectedText } }]
          : []),
        ...(draftName !== undefined && draftText !== undefined
          ? [{ id: "currentDraft", material: { name: draftName, text: draftText } }]
          : []),
        ...entries,
      ].filter(({ material }) => material.text.length > 0 || !!material.image),
    [editing, selectedText, draftName, draftText, entries, selectionName],
  );
  const textSources = sources.filter(({ material }) => !material.image);
  const canChooseTextHandling = textSources.length > 0;
  const method =
    (chosenMethod === "batch" && sources.length) || canChooseTextHandling ? chosenMethod : "full";
  const hasMaterial = sources.length > 0 || selectedText !== undefined;
  const limit = (hasMaterial || folderSearch) && limitInput ? Number(limitInput) : undefined;
  const invalidLimit = limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1);
  const exceeded = !!recipient && rejected.has(recipient);
  const outgoingSelection = method === "full" || editing ? selectedText : undefined;

  const contexts = useMemo((): MaterialPlan["contexts"] | undefined => {
    if (invalidLimit) return;
    const search = folderSearch ? (true as const) : undefined;
    if (method === "full") {
      const currentDraft =
        draftName !== undefined && draftText !== undefined
          ? { name: draftName, text: draftText }
          : undefined;
      const materials = entries.length ? entries.map(({ material }) => material) : undefined;
      return [
        currentDraft || materials || search
          ? { currentDraft, materials, folderSearch: search }
          : undefined,
      ];
    }

    if (method === "batch") {
      if (limit === undefined || editing) return;
      const batches: TaskContext[] = [];
      for (const { material } of sources) {
        const parts = batchSource(t, material, limit);
        if (!parts || batches.length + parts.length > maxBatches) return;
        for (const part of parts) batches.push({ materials: [part], folderSearch: search });
      }
      return batches.length ? batches : undefined;
    }

    const materials: NamedMaterial[] = [];
    for (const { id, revision, material } of sources) {
      if (material.image) {
        materials.push(material);
        continue;
      }
      const lines = sourceLines(material.text);
      if (method === "summary") {
        const summary = summaries.get(revision ?? id);
        if (!summary?.trim()) return;
        const location = t("materials.capacity.summaryOf", { count: String(lines.length) });
        materials.push({
          ...material,
          ...(material.range ? { format: "summary" } : {}),
          name: passageLabel(
            t,
            material.name,
            markdownHeadings(material.text),
            1,
            lines.length,
            location,
          ),
          text: summary,
        });
      } else {
        const range = ranges.get(revision ?? id) ?? initialRange;
        const first = Number(range.first);
        const last = Number(range.last);
        if (
          !Number.isSafeInteger(first) ||
          !Number.isSafeInteger(last) ||
          first < 1 ||
          last < first ||
          last > lines.length
        )
          return;
        materials.push({
          ...material,
          name: passageLabel(t, material.name, markdownHeadings(material.text), first, last),
          text: lines.slice(first - 1, last).join(""),
        });
      }
    }
    if (materials.length) return [{ materials, folderSearch: search }];
  }, [
    draftName,
    draftText,
    editing,
    entries,
    folderSearch,
    invalidLimit,
    limit,
    method,
    ranges,
    sources,
    summaries,
    t,
  ]);

  const tooLarge = useMemo(
    () =>
      limit !== undefined &&
      contexts?.some(
        (taskContext) => materialBytes({ selectedText: outgoingSelection, taskContext }) > limit,
      ),
    [limit, contexts, outgoingSelection],
  );
  const needsChoice =
    exceeded &&
    (sources.length > 0 || !!selectedText) &&
    (method === "full" || limit === undefined);
  const plan: MaterialPlan | undefined =
    !contexts || tooLarge || needsChoice
      ? undefined
      : {
          method,
          limit,
          selectedText: outgoingSelection,
          contexts,
        };
  const controls = (hasMaterial || folderSearch || exceeded) && (
    <div className="space-y-2">
      {exceeded && (
        <p role="alert" className="text-xs">
          {t("materials.capacity.rejected")}
        </p>
      )}
      <details
        className="space-y-2 rounded border border-(--mint-border) p-2 text-xs"
        open={entries.length > 0 || !!draft || exceeded || undefined}
      >
        <summary className="cursor-pointer">{t("materials.capacity.title")}</summary>
        <div className="flex flex-wrap gap-2">
          <label className="grid gap-1">
            {t("materials.capacity.limit")}
            <input
              type="number"
              min={1}
              className={fieldClass}
              value={limitInput}
              onChange={(event) => setLimit(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            {t("materials.capacity.method")}
            <select
              className={fieldClass}
              value={method}
              onChange={(event) => setMethod(event.target.value as MaterialHandling)}
            >
              <option value="full">{t("materials.capacity.full")}</option>
              <option value="excerpt" disabled={!canChooseTextHandling}>
                {t("materials.capacity.excerpt")}
              </option>
              <option value="batch" disabled={!sources.length}>
                {t("materials.capacity.batch")}
              </option>
              <option value="summary" disabled={!canChooseTextHandling}>
                {t("materials.capacity.summary")}
              </option>
            </select>
          </label>
        </div>
        <p>{t("materials.capacity.limitHelp")}</p>
        {method === "excerpt" &&
          textSources.map(({ id, revision, material }) => {
            const range = ranges.get(revision ?? id) ?? initialRange;
            const lineCount = sourceLines(material.text).length;
            const updateRange = (next: LineRange) =>
              setRanges((ranges) => new Map(ranges).set(revision ?? id, next));
            return (
              <fieldset key={id} className="flex flex-wrap gap-2">
                <legend>
                  {materialLabel(material, t)} ·{" "}
                  {t("materials.capacity.lineCount", { count: String(lineCount) })}
                </legend>
                <label className="grid gap-1">
                  {t("materials.capacity.first")}
                  <input
                    type="number"
                    min={1}
                    max={lineCount}
                    className={fieldClass}
                    value={range.first}
                    onChange={(event) => updateRange({ ...range, first: event.target.value })}
                  />
                </label>
                <label className="grid gap-1">
                  {t("materials.capacity.last")}
                  <input
                    type="number"
                    min={1}
                    max={lineCount}
                    className={fieldClass}
                    value={range.last}
                    onChange={(event) => updateRange({ ...range, last: event.target.value })}
                  />
                </label>
              </fieldset>
            );
          })}
        {method === "summary" && (
          <>
            <p>{t("materials.capacity.summaryHelp")}</p>
            {textSources.map(({ id, revision, material }) => (
              <fieldset key={id}>
                <legend>
                  {materialLabel(material, t)} ·{" "}
                  {t("materials.capacity.lineCount", {
                    count: String(sourceLines(material.text).length),
                  })}
                </legend>
                <label className="grid gap-1">
                  {t("materials.capacity.summaryInput")}
                  <textarea
                    rows={2}
                    className={fieldClass}
                    value={summaries.get(revision ?? id) ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setSummaries((previous) => new Map(previous).set(revision ?? id, value));
                    }}
                  />
                </label>
              </fieldset>
            ))}
          </>
        )}
        {(exceeded || tooLarge) && editing && !sources.length && (
          <p>{t("materials.capacity.selectionLimit")}</p>
        )}
        {invalidLimit && <p role="status">{t("materials.capacity.invalidLimit")}</p>}
        {tooLarge && <p role="status">{t("materials.capacity.tooLarge")}</p>}
        {!contexts && method === "excerpt" && (
          <p role="status">{t("materials.capacity.missingExcerpt")}</p>
        )}
        {method === "batch" && !contexts && (
          <p role="status">
            {t(editing ? "materials.capacity.batchComment" : "materials.capacity.batchLimit")}
          </p>
        )}
      </details>
      {plan && recipient && method !== "full" && (
        <MaterialPlanPreview plan={plan} recipient={recipient} />
      )}
    </div>
  );

  return {
    plan,
    method,
    controls,
    reject(key: string) {
      setRejected((previous) => new Set(previous).add(key));
    },
  };
}

export function MaterialPlanPreview({
  plan,
  recipient,
}: {
  readonly plan: MaterialPlan;
  readonly recipient: string;
}) {
  const t = useT();
  return (
    <section aria-label={t("materials.capacity.plan")} className="space-y-1 wrap-anywhere text-xs">
      <p>
        {t(`materials.capacity.${plan.method}`)} · {recipient}
      </p>
      {plan.selectedText !== undefined && (
        <details>
          <summary>
            {t("writing.scope.selection")} ·{" "}
            {t("materials.capacity.lineCount", {
              count: String(sourceLines(plan.selectedText).length),
            })}
          </summary>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap">{plan.selectedText}</pre>
        </details>
      )}
      {plan.contexts.map((context, batch) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: These entries are in send order.
        <div key={batch}>
          {plan.method === "batch" && (
            <p className="font-medium">
              {t("materials.capacity.batchNumber", {
                number: String(batch + 1),
                count: String(plan.contexts.length),
              })}
            </p>
          )}
          {[
            ...(context?.currentDraft ? [context.currentDraft] : []),
            ...(context?.materials ?? []),
          ].map((material, position) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Named sources may repeat.
            <details key={position}>
              <summary>{materialLabel(material, t)}</summary>
              <MaterialPreview material={material} />
            </details>
          ))}
        </div>
      ))}
    </section>
  );
}
