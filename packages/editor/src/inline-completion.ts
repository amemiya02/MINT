import { isolateHistory } from "@codemirror/commands";
import { Prec, StateEffect } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { sharedFileEffects } from "./file-text.ts";

export type RequestInlineCompletion = (context: {
  readonly before: string;
  readonly after: string;
  readonly signal: AbortSignal;
}) => Promise<string | null>;

const pause = 450;
const prefixLimit = 4_000;
const suffixLimit = 1_000;
const suggestionLimit = 320;

const showCompletion = StateEffect.define<{ from: number; text: string } | null>();
export const requestCompletion = StateEffect.define<RequestInlineCompletion>();

class CompletionWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  toDOM(view: EditorView) {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "cm-mint-inline-completion";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.text;
    return span;
  }
}

function insertionPoint(view: EditorView) {
  const { main, ranges } = view.state.selection;
  return view.hasFocus && !view.compositionStarted && ranges.length === 1 && main.empty
    ? main.head
    : null;
}

export function inlineCompletion(request: RequestInlineCompletion) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations = Decoration.none;
      suggestion: string | null = null;
      private timer: ReturnType<typeof setTimeout> | undefined;
      private version = 0;
      private running: AbortController | undefined;

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.focusChanged ||
          update.transactions.some((tr) => sharedFileEffects(tr).length > 0)
        ) {
          this.invalidate();
          this.suggestion = null;
          this.decorations = Decoration.none;
        }
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (effect.is(requestCompletion)) this.schedule(update.view, effect.value, 0);
            if (!effect.is(showCompletion)) continue;
            const result = effect.value;
            this.suggestion = result?.text ?? null;
            this.decorations = result
              ? Decoration.set(
                  Decoration.widget({ widget: new CompletionWidget(result.text), side: 1 }).range(
                    result.from,
                  ),
                )
              : Decoration.none;
          }
        }
        if (
          update.docChanged &&
          !update.view.compositionStarted &&
          update.transactions.some((tr) => tr.isUserEvent("input.type"))
        ) {
          this.schedule(update.view);
        }
      }

      schedule(view: EditorView, send = request, delay = pause) {
        this.invalidate();
        const version = this.version;
        this.timer = setTimeout(() => void this.complete(view, version, send), delay);
      }

      private invalidate() {
        this.version++;
        clearTimeout(this.timer);
        this.running?.abort();
        this.running = undefined;
      }

      dismiss(view: EditorView) {
        this.invalidate();
        if (!this.suggestion) return false;
        view.dispatch({ effects: showCompletion.of(null) });
        return true;
      }

      private async complete(view: EditorView, version: number, send: RequestInlineCompletion) {
        const from = insertionPoint(view);
        if (version !== this.version || from === null) return;
        const running = new AbortController();
        this.running = running;
        let text: string | null;
        try {
          text = await send({
            before: view.state.sliceDoc(Math.max(0, from - prefixLimit), from),
            after: view.state.sliceDoc(from, from + suffixLimit),
            signal: running.signal,
          });
        } catch {
          return;
        } finally {
          if (this.running === running) this.running = undefined;
        }
        if (version !== this.version || from !== insertionPoint(view)) return;
        if (!text?.trim() || text.length > suggestionLimit || /[\r\n]/.test(text)) return;
        view.dispatch({ effects: showCompletion.of({ from, text }) });
      }

      destroy() {
        this.invalidate();
      }
    },
    {
      decorations: (instance) => instance.decorations,
      eventObservers: {
        compositionstart(_event, view) {
          this.dismiss(view);
        },
        compositionend(event, view) {
          // Committing the displayed composition can leave the document unchanged.
          if (event.data) this.schedule(view);
        },
      },
    },
  );
  return [
    plugin,
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run(view) {
            const text = view.plugin(plugin)?.suggestion;
            const from = insertionPoint(view);
            if (!text || from === null) return false;
            view.dispatch({
              changes: { from, insert: text },
              selection: { anchor: from + text.length },
              annotations: isolateHistory.of("full"),
              userEvent: "input.complete",
              scrollIntoView: true,
            });
            return true;
          },
        },
        { key: "Escape", run: (view) => view.plugin(plugin)?.dismiss(view) ?? false },
      ]),
    ),
    EditorView.baseTheme({
      ".cm-mint-inline-completion": {
        color: "var(--mint-muted, #6b717a)",
        opacity: "0.75",
        pointerEvents: "none",
        userSelect: "none",
      },
    }),
  ];
}
