import { compareLines, rawLines } from "../tabs/line-diff.ts";

export interface SelectionEdit {
  readonly from: number;
  readonly to: number;
  readonly before: string;
  readonly after: string;
}

/** Use unchanged lines to separate decisions, ignoring the provider's choice of line endings. */
export function selectionEdits(before: string, after: string): SelectionEdit[] {
  const original = rawLines(before);
  const proposed = rawLines(after);
  const normalized = (line: string) => line.replace(/\r\n?/g, "\n");
  const edits: SelectionEdit[] = [];
  let left = 0;
  let right = 0;
  let from = 0;
  let to = 0;
  let replacement = "";

  function finishEdit() {
    if (from === to && !replacement) return;
    // A shared trailing line break is outside the edit, even in a mixed-ending file.
    const originalBreak = /(?:\r\n|\r|\n)$/.exec(before.slice(from, to))?.[0];
    const newBreak = /(?:\r\n|\r|\n)$/.exec(replacement)?.[0];
    const end = originalBreak && newBreak ? to - originalBreak.length : to;
    edits.push({
      from,
      to: end,
      before: before.slice(from, end),
      after: originalBreak && newBreak ? replacement.slice(0, -newBreak.length) : replacement,
    });
    replacement = "";
  }

  for (const line of compareLines(original.map(normalized), proposed.map(normalized))) {
    if (line.kind === "removed") to += original[left++]?.length ?? 0;
    else if (line.kind === "added") replacement += proposed[right++] ?? "";
    else {
      finishEdit();
      to += original[left++]?.length ?? 0;
      from = to;
      right++;
    }
  }
  finishEdit();
  return edits;
}
