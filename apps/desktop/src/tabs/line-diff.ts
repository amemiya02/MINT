import diffSequence from "@jest/diff-sequences";

/** One line of a line-by-line comparison. */
export interface DiffLine {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
}

export function rawLines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

/**
 * Compare two texts line by line (longest common subsequence). `removed` lines
 * are only in `before`, `added` lines only in `after`.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  return compareLines(before.split(/\r\n|\r|\n/), after.split(/\r\n|\r|\n/));
}

export function compareLines(a: string[], b: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  let left = 0;
  let right = 0;
  function emitRun(length: number, startA: number, startB: number) {
    while (left < startA) lines.push({ kind: "removed", text: a[left++] ?? "" });
    while (right < startB) lines.push({ kind: "added", text: b[right++] ?? "" });
    for (let i = 0; i < length; i++) lines.push({ kind: "same", text: a[left++] ?? "" });
    right += length;
  }
  diffSequence(a.length, b.length, (i, j) => a[i] === b[j], emitRun);
  emitRun(0, a.length, b.length);
  return lines;
}
