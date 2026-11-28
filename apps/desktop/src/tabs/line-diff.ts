/** One line of a line-by-line comparison. */
export interface DiffLine {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
}

/** Above this many line pairs, compare only the common start and end (keeps big files responsive). */
const MAX_CELLS = 4_000_000;

/**
 * Compare two texts line by line (longest common subsequence). `removed` lines
 * are only in `before`, `added` lines only in `after`.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  return compareLines(before.split(/\r\n|\r|\n/), after.split(/\r\n|\r|\n/));
}

export function compareLines(a: string[], b: string[]): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;

  const head = a.slice(0, start).map((text) => ({ kind: "same" as const, text }));
  const tail = a.slice(a.length - end).map((text) => ({ kind: "same" as const, text }));
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  return [...head, ...diffMiddle(midA, midB), ...tail];
}

function diffMiddle(a: readonly string[], b: readonly string[]): DiffLine[] {
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return [
      ...a.map((text) => ({ kind: "removed" as const, text })),
      ...b.map((text) => ({ kind: "added" as const, text })),
    ];
  }
  // lengths[i][j]: LCS length of a[i..] and b[j..].
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i++] ?? "" });
      j++;
    } else if (
      j >= b.length ||
      (i < a.length && (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0))
    ) {
      lines.push({ kind: "removed", text: a[i++] ?? "" });
    } else {
      lines.push({ kind: "added", text: b[j++] ?? "" });
    }
  }
  return lines;
}
