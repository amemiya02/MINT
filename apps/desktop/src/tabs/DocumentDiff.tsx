import { Fragment, useMemo } from "react";
import { useT } from "../i18n/index.ts";
import { compareLines, type DiffLine, diffLines, rawLines } from "./line-diff.ts";

/** Offsets in the draft and the exact historical bytes for each consecutive change. */
function restoreRanges(lines: DiffLine[]) {
  const ranges = new Map<number, { from: number; to: number; original: string }>();
  let offset = 0;
  let from = 0;
  let original = "";
  for (const [i, line] of lines.entries()) {
    if (line.kind !== "removed") offset += line.text.length;
    if (line.kind === "removed") original += line.text;
    if (line.kind === "same") from = offset;
    else if (!lines[i + 1] || lines[i + 1]?.kind === "same") {
      ranges.set(i, { from, to: offset, original });
      original = "";
      from = offset;
    }
  }
  return ranges;
}

export function DocumentDiff({
  before,
  after,
  onRestore,
}: {
  readonly before: string;
  readonly after: string;
  readonly onRestore?: ((text: string) => void) | undefined;
}) {
  const t = useT();
  const editable = !!onRestore;
  const { lines, ranges } = useMemo(() => {
    if (!editable) return { lines: diffLines(before, after), ranges: null };
    const lines = compareLines(rawLines(before), rawLines(after));
    return { lines, ranges: restoreRanges(lines) };
  }, [before, after, editable]);
  return (
    <pre className="min-h-0 flex-1 overflow-auto px-5 py-3 font-(family-name:--mint-font-editor) text-sm leading-relaxed">
      {lines.map((line, i) => {
        const text = line.text.replace(/[\r\n]+$/, "");
        const range = ranges?.get(i);
        return (
          <Fragment key={String(i)}>
            {line.kind === "removed" ? (
              <del className="block bg-(--mint-diff-removed-bg) no-underline">{`- ${text}`}</del>
            ) : line.kind === "added" ? (
              <ins className="block bg-(--mint-diff-added-bg) no-underline">{`+ ${text}`}</ins>
            ) : (
              <span className="block">{`  ${text}`}</span>
            )}
            {range && (
              <button
                type="button"
                className="my-1 block rounded border px-2"
                onClick={() =>
                  onRestore?.(after.slice(0, range.from) + range.original + after.slice(range.to))
                }
              >
                {t("history.restoreChange")}
              </button>
            )}
          </Fragment>
        );
      })}
    </pre>
  );
}
