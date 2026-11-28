import { parser } from "@lezer/markdown";
import { dialectParserExtensions, type EditorDialect } from "@mint/editor";
import type { NamedMaterial, TaskContext } from "./writing-sender.ts";

export interface SourceExcerpt
  extends Pick<NamedMaterial, "name" | "range" | "format" | "sourceFile"> {
  readonly quote: string;
  readonly imageId?: string;
  /** One-based line in the text actually sent. A material label may also name an original range. */
  readonly line: number;
}

export interface SourcePassage {
  readonly from: number;
  readonly claim: string;
  readonly excerpts: readonly SourceExcerpt[];
}

export function sourceMaterials(context?: TaskContext) {
  return [
    ...(context?.materials ?? []),
    ...(context?.materialDecisions ?? []).flatMap((decision) =>
      decision.outcome === "allowed" ? [decision.material] : [],
    ),
  ];
}

export function hasSourceMaterials(context?: TaskContext) {
  return sourceMaterials(context).length > 0;
}

function splitFrame(reply: string) {
  const start = /<source-passages>/i.exec(reply);
  if (!start) return { text: reply, frame: undefined };
  return {
    text: reply.slice(0, start.index).replace(/(?:\r\n|\r|\n){1,2}[\t ]*$/, ""),
    frame: /^([\s\S]*)<\/source-passages>\s*$/i.exec(
      reply.slice(start.index + start[0].length),
    )?.[1],
  };
}

export function draftText(reply: string) {
  return splitFrame(reply).text;
}

function readEntries(frame: string | undefined): readonly unknown[] {
  if (!frame) return [];
  try {
    const entries: unknown = JSON.parse(frame);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

export function readDraftPassages(
  reply: string,
  dialect: EditorDialect,
  context?: TaskContext,
  taskCopy?: string,
) {
  const materials = sourceMaterials(context);
  if (!materials.length) return { text: taskCopy ?? reply, passages: [] };
  const { text, frame } =
    taskCopy === undefined
      ? splitFrame(reply)
      : {
          text: taskCopy,
          frame: /^\s*<source-passages>([\s\S]*)<\/source-passages>\s*$/i.exec(reply)?.[1],
        };
  const byClaim = new Map<string, SourceExcerpt[]>();
  for (const entry of readEntries(frame)) {
    if (!entry || typeof entry !== "object") continue;
    const { claim, material, quote, image } = entry as Record<string, unknown>;
    if (typeof claim !== "string" || typeof material !== "number" || !Number.isInteger(material))
      continue;
    const source = materials[material - 1];
    if (!source) continue;
    const excerpts = byClaim.get(claim) ?? [];
    const { name, range, format, sourceFile, imageId } = source;
    if (source.image) {
      if (image !== true || !imageId || excerpts.some((entry) => entry.imageId === imageId))
        continue;
      excerpts.push({ name, range, format, imageId, quote: "", line: 1 });
      byClaim.set(claim, excerpts);
      continue;
    }
    if (typeof quote !== "string" || !quote.trim()) continue;
    const index = source.text.indexOf(quote);
    if (index < 0 || source.text.indexOf(quote, index + 1) >= 0) continue;
    const line = 1 + (source.text.slice(0, index).match(/\r\n|\r|\n/g)?.length ?? 0);
    if (
      excerpts.some(
        (entry) =>
          entry.name === name &&
          entry.range === range &&
          entry.format === format &&
          entry.sourceFile?.path === sourceFile?.path &&
          entry.sourceFile?.line === sourceFile?.line &&
          entry.line === line &&
          entry.quote === quote,
      )
    )
      continue;
    excerpts.push({ name, range, format, sourceFile, quote, line });
    byClaim.set(claim, excerpts);
  }

  const passages: SourcePassage[] = [];
  parser
    .configure(dialectParserExtensions(dialect))
    .parse(text)
    .iterate({
      enter({ name, from, to }) {
        if (name !== "Paragraph" && name !== "TableCell") return;
        for (const { segment, index } of sentences.segment(text.slice(from, to))) {
          const claim = segment.trim();
          if (claim) {
            passages.push({
              from: from + index + segment.length - segment.trimStart().length,
              claim,
              excerpts: byClaim.get(claim) ?? [],
            });
          }
        }
        return false;
      },
    });
  return { text, passages };
}
