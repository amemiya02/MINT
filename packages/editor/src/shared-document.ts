import { historyField, invertedEffects, isolateHistory } from "@codemirror/commands";
import {
  Compartment,
  EditorState,
  type Extension,
  Facet,
  StateEffect,
  Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { DocumentAnnotations } from "./annotations.ts";
import { copyFileDocument, sharedFileEffects } from "./file-text.ts";

import { ManualReview } from "./manual-review.ts";
import { rangeHistoryEffect } from "./range-history.ts";

const viewOwner = Facet.define<symbol, symbol | undefined>({ combine: (owners) => owners[0] });
const historyOwner = StateEffect.define<symbol>();

/** Views of one manuscript share CodeMirror changes and the immutable history field.
 * Each view maps its own selection through a sibling's changes and keeps its own viewport. */
export class SharedDocument {
  readonly annotations = new DocumentAnnotations();
  readonly review = new ManualReview();
  private views = new Set<EditorView>();
  private history = new Compartment();
  private lastWriter: symbol | undefined;

  currentDocument() {
    const first = this.views.values().next().value;
    return first && copyFileDocument(first.state);
  }

  initialHistory(): Extension {
    const first = this.views.values().next().value;
    const snapshot = first?.state.field(historyField);
    const owner = Symbol();
    return [
      this.history.of(snapshot ? historyField.init(() => snapshot) : []),
      viewOwner.of(owner),
      invertedEffects.of((tr) => {
        if (!tr.docChanged) return [];
        // A redo still belongs to the pane that made the original edit.
        return [tr.effects.find((effect) => effect.is(historyOwner)) ?? historyOwner.of(owner)];
      }),
      EditorState.transactionExtender.of((tr) =>
        tr.docChanged &&
        this.lastWriter !== owner &&
        !tr.isUserEvent("undo") &&
        !tr.isUserEvent("redo")
          ? { annotations: isolateHistory.of("before") }
          : null,
      ),
    ];
  }

  attach(view: EditorView) {
    this.views.add(view);
  }

  detach(view: EditorView) {
    this.views.delete(view);
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
      last.effects.some((e) => e.is(historyOwner) && e.value !== source.state.facet(viewOwner)) &&
      (last.isUserEvent("undo") || last.isUserEvent("redo"))
    ) {
      const selection = last.startState.selection.map(last.changes);
      const scroll = source.scrollSnapshot().map(last.changes);
      source.update([...transactions, final.state.update({ selection, effects: scroll })]);
    } else {
      source.update(transactions);
    }
    for (const transaction of changed) {
      this.review.record(transaction);
      this.annotations.record(transaction);
    }
    this.lastWriter = source.state.facet(viewOwner);
    for (const peer of this.views) {
      if (peer === source) continue;
      const updates: Transaction[] = [];
      let state = peer.state;
      for (const change of changed) {
        const update = state.update({
          changes: change.changes,
          effects: [
            ...sharedFileEffects(change),
            ...change.effects.filter((e) => e.is(rangeHistoryEffect)),
          ],
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
