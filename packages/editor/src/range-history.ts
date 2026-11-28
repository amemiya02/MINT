import { invertedEffects } from "@codemirror/commands";
import { StateEffect } from "@codemirror/state";
import type { TextRange } from "./editor.ts";

// The offsets on each side belong to the corresponding document in this history step.
export const rangeHistoryEffect = StateEffect.define<{
  readonly id: string;
  readonly phase: "apply" | "undo" | "redo";
  readonly before: readonly TextRange[];
  readonly after: readonly TextRange[];
}>();

export const rangeHistory = invertedEffects.of((transaction) =>
  transaction.effects.flatMap((effect) => {
    if (!effect.is(rangeHistoryEffect)) return [];
    const { id, phase, before, after } = effect.value;
    return [
      rangeHistoryEffect.of({
        id,
        phase: phase === "undo" ? "redo" : "undo",
        before: after,
        after: before,
      }),
    ];
  }),
);
