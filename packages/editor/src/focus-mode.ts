import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/**
 * Focus mode: only the paragraph with the cursor stays in full contrast. The
 * editor gets the `cm-mint-focus-mode` class and the lines of the current
 * paragraph `cm-mint-focused`; everything else in the document (lines and
 * block widgets alike) is dimmed. Only display changes; the text never does.
 */

/** Blocks focused as a whole. Containers (lists, quotes) are looked through to the block inside. */
const paragraphs = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "FencedCode",
  "CodeBlock",
  "Table",
  "HTMLBlock",
  "BlockMath",
  "FrontMatter",
  "HorizontalRule",
  "LinkReference",
  "CommentBlock",
  "ProcessingInstructionBlock",
]);

const focusedLine = Decoration.line({ class: "cm-mint-focused" });

/** The range of the paragraph with the main cursor; just its line when it is in no paragraph. */
function currentParagraph(state: EditorState): { from: number; to: number } {
  const { head } = state.selection.main;
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(head, side); node; node = node.parent) {
      if (paragraphs.has(node.name)) return { from: node.from, to: node.to };
    }
  }
  const line = state.doc.lineAt(head);
  return { from: line.from, to: line.to };
}

function decorations(state: EditorState): DecorationSet {
  const { from, to } = currentParagraph(state);
  const builder = new RangeSetBuilder<Decoration>();
  const last = state.doc.lineAt(to).number;
  for (let n = state.doc.lineAt(from).number; n <= last; n++) {
    const line = state.doc.line(n);
    builder.add(line.from, line.from, focusedLine);
  }
  return builder.finish();
}

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorations(view.state);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = decorations(update.state);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const focusTheme = EditorView.baseTheme({
  "&.cm-mint-focus-mode .cm-content > *": {
    transition: "opacity 0.15s",
  },
  "&.cm-mint-focus-mode .cm-content > :not(.cm-mint-focused)": {
    opacity: "var(--mint-focus-dimmed-opacity, 0.35)",
  },
});

export function focusMode(): Extension {
  return [focusPlugin, EditorView.editorAttributes.of({ class: "cm-mint-focus-mode" }), focusTheme];
}
