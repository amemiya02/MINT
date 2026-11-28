import { historyField } from "@codemirror/commands";
import { Compartment, type Extension, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fileText, sharedFileEffects } from "./file-text.ts";

/** Views of one manuscript share CodeMirror changes and the immutable history field.
 * Each view maps its own selection through a sibling's changes and keeps its own viewport. */
export class SharedDocument {
  private views = new Set<EditorView>();
  private history = new Compartment();
  private lastWriter: EditorView | null = null;

  currentText(): string | undefined {
    const first = this.views.values().next().value;
    return first ? fileText(first.state) : undefined;
  }

  initialHistory(): Extension {
    const first = this.views.values().next().value;
    const snapshot = first?.state.field(historyField);
    return this.history.of(snapshot ? historyField.init(() => snapshot) : []);
  }

  attach(view: EditorView) {
    this.views.add(view);
  }

  detach(view: EditorView) {
    this.views.delete(view);
    if (this.lastWriter === view) this.lastWriter = null;
  }

  dispatch(transactions: readonly Transaction[], source: EditorView) {
    const changed = transactions.filter((t) => t.docChanged || sharedFileEffects(t).length > 0);
    const last = changed.at(-1);
    const final = transactions.at(-1);
    if (!last || !final) {
      source.update(transactions);
      return;
    }
    if (
      this.views.size > 1 &&
      this.lastWriter !== source &&
      (last.isUserEvent("undo") || last.isUserEvent("redo"))
    ) {
      const selection = last.startState.selection.map(last.changes);
      const scroll = source.scrollSnapshot().map(last.changes);
      source.update([...transactions, final.state.update({ selection, effects: scroll })]);
    } else {
      source.update(transactions);
    }
    this.lastWriter = source;
    for (const peer of this.views) {
      if (peer === source) continue;
      const updates: Transaction[] = [];
      let state = peer.state;
      for (const change of changed) {
        const update = state.update({
          changes: change.changes,
          effects: sharedFileEffects(change),
          annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
          filter: false,
        });
        updates.push(update);
        state = update.state;
      }
      const snapshot = source.state.field(historyField);
      updates.push(
        state.update({ effects: this.history.reconfigure(historyField.init(() => snapshot)) }),
      );
      peer.update(updates);
    }
  }
}
