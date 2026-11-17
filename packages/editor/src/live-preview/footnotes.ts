import type { Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type PreviewContext, type PreviewRenderer, previewRenderer } from "./preview.ts";

const referenceLabel = Decoration.mark({ class: "cm-mint-footnote-ref" });
const definitionLabel = Decoration.mark({ class: "cm-mint-footnote-label" });

/** `[^label]`: shown as a superscript label; a span, revealed when the selection touches it. */
function renderReference(node: SyntaxNode, cx: PreviewContext) {
  const label = node.getChild("FootnoteLabel");
  if (!label) return;
  cx.add(label.from, label.to, referenceLabel);
  if (cx.touchesSelection(node.from, node.to)) return;
  for (const mark of node.getChildren("FootnoteMark")) cx.hide(mark.from, mark.to);
}

/** `[^label]: text`: shown as `label: text`; the brackets come back while the cursor is on its first line. */
function renderDefinition(node: SyntaxNode, cx: PreviewContext) {
  const label = node.getChild("FootnoteLabel");
  const [open, close] = node.getChildren("FootnoteMark");
  if (!label || !open || !close) return;
  cx.add(label.from, label.to, definitionLabel);
  if (cx.touchesSelectedLines(open.from, close.to)) return;
  cx.hide(open.from, open.to);
  cx.hide(close.from, close.from + 1); // `]`, keeping the `:`
}

const renderer: PreviewRenderer = {
  nodes: ["FootnoteReference", "FootnoteDefinition"],
  render(node, cx) {
    if (node.name === "FootnoteReference") renderReference(node, cx);
    else renderDefinition(node, cx);
    return undefined;
  },
};

const theme = EditorView.baseTheme({
  ".cm-mint-footnote-ref": {
    verticalAlign: "super",
    fontSize: "0.75em",
    color: "var(--mint-link, #2f7d6d)",
  },
  ".cm-mint-footnote-label": { color: "var(--mint-link, #2f7d6d)", fontWeight: "600" },
});

/** GFM footnote references and definitions (parsed by footnote-syntax.ts when GFM is on). */
export const footnotes: Extension = [previewRenderer.of(renderer), theme];
