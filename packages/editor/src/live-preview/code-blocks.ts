import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type PreviewContext, type PreviewRenderer, previewRenderer } from "./preview.ts";

/** The fenced code block around `pos`, if any. */
function fencedCodeAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, pos, 200) ?? syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === "FencedCode") return node;
    }
  }
  return null;
}

/** Where a block's language (info string) is, or would be inserted. */
function infoRange(block: SyntaxNode): { from: number; to: number } | null {
  const info = block.getChild("CodeInfo");
  if (info) return { from: info.from, to: info.to };
  const fence = block.getChild("CodeMark");
  return fence && fence.from === block.from ? { from: fence.to, to: fence.to } : null;
}

/**
 * Set the language of the fenced code block at the cursor. Only the info
 * string changes. Returns false when the cursor is not in a fenced code block.
 */
export function setCodeBlockLanguage(view: EditorView, language: string): boolean {
  const block = fencedCodeAt(view.state, view.state.selection.main.head);
  const range = block && infoRange(block);
  if (!range) return false;
  const insert = language.trim().replace(/\s+/g, "-");
  if (view.state.sliceDoc(range.from, range.to) === insert) return true;
  view.dispatch({ changes: { ...range, insert }, userEvent: "input.language" });
  return true;
}

/** The language label shown in place of the opening fence. Clicking it selects the language for editing. */
class LanguageLabel extends WidgetType {
  constructor(readonly language: string) {
    super();
  }
  override eq(other: LanguageLabel) {
    return other.language === this.language;
  }
  toDOM(view: EditorView) {
    const label = document.createElement("span");
    label.className = "cm-mint-code-language";
    label.textContent = this.language;
    label.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const block = fencedCodeAt(view.state, view.posAtDOM(label));
      const range = block && infoRange(block);
      if (!range) return;
      view.dispatch({ selection: EditorSelection.single(range.from, range.to) });
      view.focus();
    });
    return label;
  }
  override ignoreEvent() {
    return true;
  }
}

const codeLine = Decoration.line({ class: "cm-mint-codeblock" });

function render(block: SyntaxNode, cx: PreviewContext) {
  const { doc } = cx.state;
  const first = doc.lineAt(block.from);
  const last = doc.lineAt(block.to);
  for (let n = first.number; n <= last.number; n++) cx.line(doc.line(n).from, codeLine);
  // Like other block widgets, the source comes back while the cursor is in the block.
  if (cx.touchesSelectedLines(block.from, block.to)) return;

  const info = block.getChild("CodeInfo");
  const opening = { from: block.from, to: first.to };
  if (info) {
    const language = doc.sliceString(info.from, info.to).split(/\s/)[0] ?? "";
    cx.add(opening.from, opening.to, Decoration.replace({ widget: new LanguageLabel(language) }));
  } else {
    cx.hide(opening.from, opening.to);
  }
  const closing = block.getChildren("CodeMark").find((mark) => mark.from > first.to);
  if (closing) cx.hide(doc.lineAt(closing.from).from, closing.to);
}

const renderer: PreviewRenderer = {
  nodes: ["FencedCode"],
  render(node, cx) {
    render(node, cx);
    return false;
  },
};

const theme = EditorView.baseTheme({
  ".cm-mint-codeblock": {
    fontFamily: "var(--mint-font-code, monospace)",
    backgroundColor: "var(--mint-code-bg, rgba(127, 127, 127, 0.1))",
    paddingLeft: "0.8em",
  },
  ".cm-mint-code-language": {
    float: "right",
    cursor: "pointer",
    fontSize: "0.8em",
    color: "var(--mint-marker, #8a9099)",
  },
});

/** Fenced code blocks: background, language label; highlighting comes from the dialect's code languages. */
export const codeBlocks: Extension = [previewRenderer.of(renderer), theme];
