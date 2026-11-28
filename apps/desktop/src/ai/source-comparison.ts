import {
  loadMaterialSource,
  prepareRangedMaterial,
  rangedSource,
  readMaterialText,
  sourceLines,
} from "./material-source.ts";
import { type SourceExcerpt, sourceMaterials } from "./source-passages.ts";
import type { TaskContext } from "./writing-sender.ts";
import { mapReviewRanges } from "./writing-tasks.ts";

export function sentSource(excerpt: SourceExcerpt, context?: TaskContext) {
  if (excerpt.imageId)
    return sourceMaterials(context).find(({ imageId }) => imageId === excerpt.imageId);
  const count = sourceLines(excerpt.quote).length;
  const matching = sourceMaterials(context).filter(
    (material) =>
      material.name === excerpt.name &&
      material.format === excerpt.format &&
      JSON.stringify(material.range) === JSON.stringify(excerpt.range) &&
      sourceLines(material.text)
        .slice(excerpt.line - 1, excerpt.line - 1 + count)
        .join("")
        .includes(excerpt.quote),
  );
  return matching.length === 1 ? matching[0] : undefined;
}

export async function readSourceRevision(file: File, excerpt: SourceExcerpt) {
  const { range, format } = excerpt;
  if (range?.kind !== "pdf" || format !== "extractedText")
    return readMaterialText(file, { allowBlank: true });
  const original = rangedSource(file);
  if (original?.kind !== "pdf" || file.size > 32 * 1024 * 1024) throw new Error("invalidMaterial");
  const source = await loadMaterialSource(original);
  try {
    return (await prepareRangedMaterial(file.name, source, range, format, "", { allowBlank: true }))
      .text;
  } finally {
    await source.dispose();
  }
}

/** Return the current passage in the approved material range, or an empty string if it was removed. */
export function compareSource(excerpt: SourceExcerpt, revised: string, sent?: string) {
  const { quote, line } = excerpt;
  const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
  const normalizedQuote = normalize(quote);
  const normalizedRevision = normalize(revised);
  const first = normalizedRevision.indexOf(normalizedQuote);
  const length = sourceLines(quote).length;
  const sentLines = sent === undefined ? undefined : sourceLines(sent);
  const original = sentLines?.slice(line - 1, line - 1 + length).join("");
  if (first >= 0 && normalizedRevision.indexOf(normalizedQuote, first + 1) < 0) {
    if (original === undefined) return quote;
    // A correction can repeat the old quote inside a changed line.
    const start = first ? normalizedRevision.lastIndexOf("\n", first - 1) + 1 : 0;
    const end = normalizedRevision.indexOf("\n", first + normalizedQuote.trimEnd().length);
    const latest = normalizedRevision.slice(start, end < 0 ? undefined : end).trim();
    return latest === normalize(original).trim() ? quote : latest;
  }
  if (sent === undefined || !sentLines || original === undefined || excerpt.sourceFile) {
    const start = (excerpt.sourceFile?.line ?? 1) + line - 2;
    return sourceLines(revised)
      .slice(start, start + length)
      .join("")
      .trim();
  }
  const from = sentLines.slice(0, line - 1).join("").length;
  const end = from + original.length;
  const mapped = mapReviewRanges(sent, revised).range({ from, to: end, located: true });
  return revised.slice(mapped.from, mapped.to).trim();
}
