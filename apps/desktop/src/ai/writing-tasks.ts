import { compareLines, rawLines } from "../tabs/line-diff.ts";
import type { TaskContext, WritingTurn } from "./writing-sender.ts";

export type EditStatus = "preview" | "applied" | "discarded" | "reverted";

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
  readonly comments?: readonly (WritingTurn & { readonly id: number })[];
  readonly range: ReviewRange;
}

export interface SavedTurn extends WritingTurn {
  readonly material?: string;
  readonly context?: TaskContext;
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
  readonly showSource: boolean;
  readonly turns: readonly SavedTurn[];
  readonly pending?: Omit<SavedTurn, "reply" | "suggestions" | "direct">;
}

export interface WritingTasksPlatform {
  list(path: string | null): Promise<SavedWritingTask[]>;
  create(task: SavedWritingTask): Promise<void>;
  update(task: SavedWritingTask): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Translate file offsets across a restart. Unchanged lines remain independent anchors. */
export function mapReviewRanges(before: string, after: string) {
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
    changes.push({
      from: from + prefix,
      to: from + removed.length - suffix,
      start: start + prefix,
      end: start + added.length - suffix,
    });
    from += removed.length;
    start += added.length;
    removed = "";
    added = "";
  }

  if (before !== after) {
    for (const line of compareLines(rawLines(before), rawLines(after))) {
      if (line.kind === "removed") removed += line.text;
      else if (line.kind === "added") added += line.text;
      else {
        finish();
        from += line.text.length;
        start += line.text.length;
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
