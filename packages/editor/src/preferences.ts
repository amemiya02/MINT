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

interface Preferences {
  readonly vim: boolean;
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

/** Extensions for the Vim and spellcheck settings, swappable while the editor runs. */
export function editorPreferences(initial: Preferences) {
  const vimSlot = new Compartment();
  const spellcheckSlot = new Compartment();
  // Vim sees keys before every other key binding of the editor.
  const vimExtension = (on: boolean) => (on ? Prec.highest(vim()) : []);
  const spellcheck = (on: boolean) => (on ? spellcheckExtension : []);
  return {
    extension: [
      vimSlot.of(vimExtension(initial.vim)),
      spellcheckSlot.of(spellcheck(initial.spellcheck)),
    ],
    /** The effects that take the editor from the `before` settings to the `after` ones. */
    reconfigure(before: Preferences, after: Preferences) {
      const effects = [];
      if (after.vim !== before.vim) effects.push(vimSlot.reconfigure(vimExtension(after.vim)));
      if (after.spellcheck !== before.spellcheck) {
        effects.push(spellcheckSlot.reconfigure(spellcheck(after.spellcheck)));
      }
      return effects;
    },
  };
}
