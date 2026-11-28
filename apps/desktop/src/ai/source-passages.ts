import { GFM, parser } from "@lezer/markdown";
import type { TaskContext } from "./writing-sender.ts";

interface SourceExcerpt {
  readonly name: string;
  readonly quote: string;
  /** One-based line in the text actually sent. A material label may also name an original range. */
  readonly line: number;
}

export interface SourcePassage {
  readonly from: number;
  readonly claim: string;
  readonly excerpts: readonly SourceExcerpt[];
}

function sourceMaterials(context?: TaskContext) {
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

const markdown = parser.configure(GFM);
const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

export function readDraftPassages(reply: string, context?: TaskContext) {
  const materials = sourceMaterials(context);
  if (!materials.length) return { text: reply, passages: [] };
  const { text, frame } = splitFrame(reply);
  const byClaim = new Map<string, SourceExcerpt[]>();
  for (const entry of readEntries(frame)) {
    if (!entry || typeof entry !== "object") continue;
    const { claim, material, quote } = entry as Record<string, unknown>;
    if (typeof claim !== "string" || typeof quote !== "string" || !quote.trim()) continue;
    if (typeof material !== "number" || !Number.isInteger(material)) continue;
    const source = materials[material - 1];
    if (!source) continue;
    const index = source.text.indexOf(quote);
    if (index < 0 || source.text.indexOf(quote, index + 1) >= 0) continue;
    const line = 1 + (source.text.slice(0, index).match(/\r\n|\r|\n/g)?.length ?? 0);
    const excerpts = byClaim.get(claim) ?? [];
    if (
      excerpts.some(
        (entry) => entry.name === source.name && entry.line === line && entry.quote === quote,
      )
    )
      continue;
    excerpts.push({ name: source.name, quote, line });
    byClaim.set(claim, excerpts);
  }

  const passages: SourcePassage[] = [];
  markdown.parse(text).iterate({
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
