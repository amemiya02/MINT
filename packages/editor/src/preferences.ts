import { syntaxTree } from "@codemirror/language";
import { Compartment, type Extension, Prec, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";

/** Ways of editing that the user switches on and off (the host keeps them in its settings). */
export interface EditorPreferences {
  /** Vim key bindings: normal, insert and visual modes, and `:` commands. */
  readonly vim: boolean;
  /** The system spellchecker underlines misspelled words in the text (not in code, math or URLs). */
  readonly spellcheck: boolean;
}

/** Syntax whose words are not prose and are never spellchecked. */
const notProse = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "InlineMath",
  "BlockMath",
  "URL",
  "HTMLBlock",
  "HTMLTag",
  "FrontMatter",
]);

const unchecked = Decoration.mark({ attributes: { spellcheck: "false" } });

function uncheckedRanges(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (!notProse.has(node.name)) return;
        if (node.to > node.from) builder.add(node.from, node.to, unchecked);
        return false;
      },
    });
  }
  return builder.finish();
}

const spellcheckExtension: Extension = [
  EditorView.contentAttributes.of({
    spellcheck: "true",
    // Only underline: never let the system rewrite Markdown as it is typed.
    autocorrect: "off",
    autocapitalize: "off",
  }),
  ViewPlugin.define(
    (view) => ({
      decorations: uncheckedRanges(view),
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.state) !== syntaxTree(update.startState)
        ) {
          this.decorations = uncheckedRanges(update.view);
        }
      },
    }),
    { decorations: (plugin) => plugin.decorations },
  ),
];

/** Extensions for each preference, swappable while the editor runs. */
export function editorPreferences(initial: EditorPreferences) {
  const vimSlot = new Compartment();
  const spellcheckSlot = new Compartment();
  // Vim sees keys before every other key binding of the editor.
  const vimExtension = (on: boolean) => (on ? Prec.highest(vim()) : []);
  const spellcheck = (on: boolean) => (on ? spellcheckExtension : []);
  let current = initial;
  return {
    extension: [
      vimSlot.of(vimExtension(current.vim)),
      spellcheckSlot.of(spellcheck(current.spellcheck)),
    ],
    get: (): EditorPreferences => current,
    configure(view: EditorView, next: Partial<EditorPreferences>) {
      const updated = { ...current, ...next };
      const effects = [];
      if (updated.vim !== current.vim) effects.push(vimSlot.reconfigure(vimExtension(updated.vim)));
      if (updated.spellcheck !== current.spellcheck) {
        effects.push(spellcheckSlot.reconfigure(spellcheck(updated.spellcheck)));
      }
      current = updated;
      if (effects.length > 0) view.dispatch({ effects });
    },
  };
}
