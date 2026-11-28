import diffSequence from "@jest/diff-sequences";
import { compareLines, rawLines } from "../tabs/line-diff.ts";
import type { AttemptStatus } from "./writing-attempt.ts";
import type { TaskContext, WritingTurn } from "./writing-sender.ts";

export type EditStatus = "preview" | "applied" | "discarded" | "reverted" | "kept";

export interface ReviewRange {
  readonly from: number;
  readonly to: number;
  readonly located: boolean;
}

export interface SavedSuggestion {
  readonly id: number;
  readonly before: string;
  readonly after: string;
  readonly status: EditStatus;
  readonly appliedText?: string;
  readonly note?: string;
  readonly batchApplied?: boolean;
  readonly comments?: readonly (WritingTurn & { readonly id: number })[];
  readonly range: ReviewRange;
}

export interface SavedTurn extends WritingTurn {
  readonly status?: AttemptStatus;
  readonly partial?: string;
  readonly material?: string;
  readonly context?: TaskContext;
  readonly searchFolder?: string;
  readonly recipient: string;
  readonly recipientId: string;
  readonly direct: boolean;
  readonly suggestions?: readonly SavedSuggestion[];
}

export interface SavedWritingTask {
  readonly version: 1;
  readonly id: string;
  readonly path: string | null;
  readonly title: string;
  readonly updatedAt: number;
  readonly baseline: string;
  readonly origin: ReviewRange & { readonly text: string };
  readonly reading: { readonly anchor: number; readonly head: number; readonly top: number };
  readonly reviewScroll: number;
  readonly reviewSelection?: string;
  readonly showSource: boolean;
  readonly turns: readonly SavedTurn[];
  readonly pending?: Omit<SavedTurn, "reply" | "suggestions" | "direct" | "status" | "partial">;
}

export interface WritingTasksPlatform {
  list(path: string | null): Promise<SavedWritingTask[]>;
  listReviewsInFolder(folder: string): Promise<readonly SavedReviewLink[]>;
  create(task: SavedWritingTask): Promise<void>;
  update(task: SavedWritingTask, expectedUpdatedAt: number): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface SavedReviewLink {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

export interface WritingReviewRequest {
  readonly task: SavedWritingTask;
  readonly returnToTab: number;
  readonly complete: (opened: boolean) => void;
}

export interface WritingTasksRequest {
  readonly sequence: number;
  readonly mode: "history" | "review";
}

export function hasProposedEdits(task: SavedWritingTask) {
  return task.turns.some((turn) => !!turn.suggestions?.length);
}

interface OpenWritingReview {
  readonly busy: boolean;
  focus(returnToTab?: number): void;
  remove(remaining: number): void;
}

const openReviews = new WeakMap<WritingTasksPlatform, Map<string, OpenWritingReview>>();

/** Each window keeps one composer per review, including across editor panes. */
export function openWritingReviews(tasks: WritingTasksPlatform) {
  const reviews = openReviews.get(tasks) ?? new Map<string, OpenWritingReview>();
  openReviews.set(tasks, reviews);
  return reviews;
}

const writes = new WeakMap<WritingTasksPlatform, Promise<void>>();
const openCheckpoints = new WeakMap<WritingTasksPlatform, Set<() => void>>();

/** Keep checkpoints ordered and let the desktop wait for them before closing its window. */
export function writeTaskCheckpoint(tasks: WritingTasksPlatform, update: () => Promise<void>) {
  const result = (writes.get(tasks) ?? Promise.resolve()).then(update);
  writes.set(
    tasks,
    result.catch(() => {}),
  );
  return result;
}

export function writingTaskWrites(tasks: WritingTasksPlatform) {
  return writes.get(tasks) ?? Promise.resolve();
}

export function registerTaskCheckpoint(tasks: WritingTasksPlatform, checkpoint: () => void) {
  const callbacks = openCheckpoints.get(tasks) ?? new Set<() => void>();
  openCheckpoints.set(tasks, callbacks);
  callbacks.add(checkpoint);
  return () => {
    callbacks.delete(checkpoint);
  };
}

export async function checkpointOpenWritingTasks(tasks: WritingTasksPlatform) {
  for (const checkpoint of openCheckpoints.get(tasks) ?? []) checkpoint();
  await writingTaskWrites(tasks);
}

/** Translate file offsets across a restart. Unchanged lines remain independent anchors. */
export function mapReviewRanges(before: string, after: string) {
  // A full rewrite can form one large hunk. Keep its outer anchors and bound
  // the character diff so opening a review cannot stall on unrelated text.
  const maxDetailedDiffLength = 4_096;
  const changes: { from: number; to: number; start: number; end: number }[] = [];
  let from = 0;
  let start = 0;
  let removed = "";
  let added = "";

  function finish() {
    if (!removed && !added) return;
    let prefix = 0;
    const shared = Math.min(removed.length, added.length);
    while (prefix < shared && removed[prefix] === added[prefix]) prefix++;
    let suffix = 0;
    while (suffix < shared - prefix && removed.at(-1 - suffix) === added.at(-1 - suffix)) suffix++;
    const leftEnd = removed.length - suffix;
    const rightEnd = added.length - suffix;
    let left = prefix;
    let right = prefix;
    function recordGap(length: number, nextLeft: number, nextRight: number) {
      if (left !== nextLeft || right !== nextRight) {
        changes.push({
          from: from + left,
          to: from + nextLeft,
          start: start + right,
          end: start + nextRight,
        });
      }
      left = nextLeft + length;
      right = nextRight + length;
    }
    if (leftEnd + rightEnd - 2 * prefix <= maxDetailedDiffLength) {
      diffSequence(
        leftEnd - prefix,
        rightEnd - prefix,
        (i, j) => removed.charCodeAt(i + prefix) === added.charCodeAt(j + prefix),
        (length, i, j) => recordGap(length, i + prefix, j + prefix),
      );
    }
    recordGap(0, leftEnd, rightEnd);
    from += removed.length;
    start += added.length;
    removed = "";
    added = "";
  }

  if (before !== after) {
    const beforeLines = rawLines(before);
    const afterLines = rawLines(after);
    const normalize = (line: string) => line.replace(/\r\n?/g, "\n");
    let i = 0;
    let j = 0;
    for (const line of compareLines(beforeLines.map(normalize), afterLines.map(normalize))) {
      if (line.kind === "removed") removed += beforeLines[i++] ?? "";
      else if (line.kind === "added") added += afterLines[j++] ?? "";
      else {
        finish();
        removed = beforeLines[i++] ?? "";
        added = afterLines[j++] ?? "";
        finish();
      }
    }
    finish();
  }

  function point(offset: number, right: boolean) {
    let delta = 0;
    for (const { from, to, start, end } of changes) {
      if (offset < from) break;
      if (offset === from) return { offset: from === to && right ? end : start, located: true };
      if (offset < to) return { offset: right ? start : end, located: false };
      if (offset === to) return { offset: end, located: true };
      delta = end - to;
    }
    return { offset: offset + delta, located: true };
  }

  return {
    point: (offset: number) => point(offset, true).offset,
    range({ from, to, located }: ReviewRange): ReviewRange {
      const start = point(from, from !== to);
      const end = point(to, from === to);
      return {
        from: start.offset,
        to: Math.max(start.offset, end.offset),
        located: located && start.located && end.located,
      };
    },
  };
}
