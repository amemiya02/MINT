import { ChangeSet, type ChangeSpec, type Transaction } from "@codemirror/state";
import type { MintEditor } from "./editor.ts";
import { fileText, fromFileOffset, sharedFileEffects, toFileOffset } from "./file-text.ts";

/** File offsets and exact text on both sides of one undecided edit. */
export interface Revision {
  readonly from: number;
  readonly to: number;
  readonly line: number;
  readonly column: number;
  readonly before: string;
  readonly after: string;
}

/** Track the inverse of the author's actual edits, including edits from a sibling view. */
export class ManualReview {
  private revisions: readonly Revision[] | null = null;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.revisions;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(revisions: readonly Revision[] | null) {
    this.revisions = revisions;
    for (const listener of this.listeners) listener();
  }

  start() {
    this.publish([]);
  }
  stop() {
    this.publish(null);
  }

  accept(change: Revision) {
    if (this.revisions?.includes(change))
      this.publish(this.revisions.filter((item) => item !== change));
  }

  reject(change: Revision, editor: MintEditor) {
    if (!this.revisions?.includes(change)) return;
    const draft = editor.getText();
    editor.replaceText(draft.slice(0, change.from) + change.before + draft.slice(change.to));
  }

  record(tr: Transaction) {
    if (!this.revisions) return;
    const before = fileText(tr.startState);
    const after = fileText(tr.state);
    if (before === after) return;
    const inverse: ChangeSpec[] = [];
    if (sharedFileEffects(tr).length) {
      // Reload and history transactions can change file metadata outside their editor range.
      let from = 0;
      while (from < before.length && before[from] === after[from]) from++;
      let endA = before.length;
      let endB = after.length;
      while (endA > from && endB > from && before[endA - 1] === after[endB - 1]) {
        endA--;
        endB--;
      }
      inverse.push({ from, to: endB, insert: before.slice(from, endA) });
    } else {
      tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        inverse.push({
          from: toFileOffset(tr.state, fromB),
          to: toFileOffset(tr.state, toB),
          insert: before.slice(
            toFileOffset(tr.startState, fromA),
            toFileOffset(tr.startState, toA),
          ),
        });
      });
    }
    // Use LF explicitly so literal CR and CRLF occupy their original number of file offsets.
    const previous = ChangeSet.of(
      this.revisions.map((item) => ({
        from: item.from,
        to: item.to,
        insert: item.before,
      })),
      before.length,
      "\n",
    );
    const combined = ChangeSet.of(inverse, after.length, "\n").compose(previous);
    const next: Revision[] = [];
    combined.iterChanges((from, to, _fromB, _toB, inserted) => {
      const original = inserted.toString();
      const replacement = after.slice(from, to);
      if (original === replacement) return;
      const pos = fromFileOffset(tr.state, from);
      const line = tr.newDoc.lineAt(pos);
      next.push({
        from,
        to,
        line: line.number,
        column: pos - line.from + 1,
        before: original,
        after: replacement,
      });
    });
    this.publish(next);
  }
}
