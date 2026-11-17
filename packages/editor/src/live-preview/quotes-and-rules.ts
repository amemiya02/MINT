import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type PreviewContext, type PreviewRenderer, previewRenderer } from "./preview.ts";

const quoteLine = Decoration.line({ class: "cm-mint-blockquote" });

function renderBlockquote(node: SyntaxNode, cx: PreviewContext) {
  const { doc } = cx.state;
  // Nested quotes share the outermost quote's lines.
  if (!isInsideQuote(node.parent)) {
    for (let pos = node.from; pos <= node.to; ) {
      const line = doc.lineAt(pos);
      cx.line(line.from, quoteLine);
      pos = line.to + 1;
    }
  }
}

/** A `>` marker (it may sit inside the quote's paragraph, on a continuation line). */
function renderQuoteMark(mark: SyntaxNode, cx: PreviewContext) {
  if (cx.touchesSelection(mark.from, mark.to)) return;
  const space = /[ \t]/.test(cx.state.sliceDoc(mark.to, mark.to + 1)) ? 1 : 0;
  cx.hide(mark.from, mark.to + space);
}

function isInsideQuote(node: SyntaxNode | null): boolean {
  for (let n = node; n; n = n.parent) if (n.name === "Blockquote") return true;
  return false;
}

class RuleWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const rule = document.createElement("hr");
    rule.className = "cm-mint-hr";
    return rule;
  }
}
const rule = Decoration.replace({ widget: new RuleWidget() });

const renderer: PreviewRenderer = {
  nodes: ["Blockquote", "QuoteMark", "HorizontalRule"],
  render(node, cx) {
    if (node.name === "Blockquote") renderBlockquote(node, cx);
    else if (node.name === "QuoteMark") renderQuoteMark(node, cx);
    else if (!cx.touchesSelection(node.from, node.to)) cx.add(node.from, node.to, rule);
    return undefined;
  },
};

const theme = EditorView.baseTheme({
  ".cm-mint-blockquote": {
    borderLeft: "3px solid var(--mint-border, #d0d7de)",
    paddingLeft: "0.8em",
    color: "var(--mint-quote-fg, inherit)",
  },
  ".cm-mint-hr": {
    display: "inline-block",
    width: "100%",
    border: "none",
    borderTop: "1px solid var(--mint-border, #d0d7de)",
    margin: "0",
    verticalAlign: "middle",
  },
});

/** Block quotes (`> `) and horizontal rules (`---`, `***`, `___`). */
export const quotesAndRules: Extension = [previewRenderer.of(renderer), theme];
