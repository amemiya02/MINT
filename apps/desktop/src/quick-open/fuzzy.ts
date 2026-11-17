import { lastSeparator } from "../paths.ts";

/**
 * Fuzzy matching of a quick open query against a path. The query's letters
 * must appear in order (case-insensitive, spaces ignored). Consecutive letters
 * and letters at word starts score higher, and a match that fits in the file
 * name beats one spread across folder names.
 */

export interface FuzzyMatch {
  readonly score: number;
  /** Indices into the path of the matched characters, ascending. */
  readonly positions: readonly number[];
}

const fileNameBonus = 1000;
const consecutiveBonus = 5;
const wordStartBonus = 4;

/** Match `query` against `path`, or `null` if its letters do not all appear in order. */
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const needle = query.replace(/\s+/g, "").toLowerCase();
  if (needle === "") return { score: 0, positions: [] };
  const nameStart = lastSeparator(path) + 1;
  const inName = align(needle, path.slice(nameStart));
  if (inName) {
    return {
      score: inName.score + fileNameBonus,
      positions: inName.positions.map((p) => p + nameStart),
    };
  }
  return align(needle, path);
}

/** Best-scoring placement of `needle`'s letters in `text` (dynamic programming). */
function align(needle: string, text: string): FuzzyMatch | null {
  const hay = text.toLowerCase();
  const n = needle.length;
  const m = hay.length;
  if (n > m) return null;
  // score[i][j]: best score with needle[0..i] placed and needle[i] at text[j].
  const score: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < n; i++) {
    score.push(new Array<number>(m).fill(Number.NEGATIVE_INFINITY));
    from.push(new Array<number>(m).fill(-1));
    // Best score of row i-1 over positions before j-1, and where it was.
    let bestBefore = Number.NEGATIVE_INFINITY;
    let bestBeforeAt = -1;
    for (let j = i; j < m; j++) {
      if (i > 0 && j >= 2) {
        const candidate = score[i - 1]?.[j - 2] ?? Number.NEGATIVE_INFINITY;
        if (candidate > bestBefore) {
          bestBefore = candidate;
          bestBeforeAt = j - 2;
        }
      }
      if (hay[j] !== needle[i]) continue;
      const own = 1 + (isWordStart(text, j) ? wordStartBonus : 0);
      const row = score[i] as number[];
      const back = from[i] as number[];
      if (i === 0) {
        row[j] = own;
        continue;
      }
      const adjacent = (score[i - 1]?.[j - 1] ?? Number.NEGATIVE_INFINITY) + consecutiveBonus;
      if (adjacent >= bestBefore && adjacent > Number.NEGATIVE_INFINITY) {
        row[j] = own + adjacent;
        back[j] = j - 1;
      } else if (bestBefore > Number.NEGATIVE_INFINITY) {
        row[j] = own + bestBefore;
        back[j] = bestBeforeAt;
      }
    }
  }
  const last = score[n - 1] as number[];
  let end = -1;
  let best = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < m; j++) {
    const s = last[j] as number;
    if (s > best) {
      best = s;
      end = j;
    }
  }
  if (end < 0) return null;
  const positions: number[] = [];
  for (let i = n - 1, j = end; i >= 0; i--) {
    positions.unshift(j);
    j = (from[i] as number[])[j] as number;
  }
  return { score: best, positions };
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text.charAt(index - 1);
  if (/[\s/\\_.-]/.test(before)) return true;
  const here = text.charAt(index);
  // camelCase boundary
  return before === before.toLowerCase() && here !== here.toLowerCase();
}
