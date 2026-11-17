import "katex/dist/katex.min.css";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import katex from "katex";
import { mathSource } from "../math-syntax.ts";
import { type PreviewContext, type PreviewRenderer, previewRenderer } from "./preview.ts";

/** Class on every rendered formula (inline or block). */
export const mathClass = "cm-mint-math";

/**
 * A formula rendered with KaTeX. A malformed formula shows KaTeX's error
 * message instead. Clicking the formula moves the cursor into its source,
 * which reveals it.
 */
class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** Where a click puts the cursor, relative to the start of the replaced range. */
    readonly cursorOffset: number,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return (
      other.tex === this.tex &&
      other.display === this.display &&
      other.cursorOffset === this.cursorOffset
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const dom: HTMLElement = document.createElement(this.display ? "div" : "span");
    dom.className = `${mathClass} ${mathClass}-${this.display ? "block" : "inline"}`;
    try {
      katex.render(this.tex, dom, {
        displayMode: this.display,
        throwOnError: true,
        strict: "ignore",
      });
    } catch (error) {
      dom.classList.add(`${mathClass}-error`);
      dom.textContent = error instanceof Error ? error.message : String(error);
      dom.title = this.tex;
    }
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const anchor = view.posAtDOM(dom) + this.cursorOffset;
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      view.focus();
    });
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** A widget replacing `from`–`to`, unless the selection touches it (then the source shows). */
function renderInline(node: SyntaxNode, cx: PreviewContext) {
  if (cx.touchesSelection(node.from, node.to)) return;
  const open = node.getChild("MathMark");
  const widget = new MathWidget(
    mathSource(node, cx.state.doc),
    false,
    open ? open.to - node.from : 0,
  );
  cx.add(node.from, node.to, Decoration.replace({ widget }));
}

const isMultiLine = (node: SyntaxNode, { state }: { state: EditorState }) =>
  state.doc.lineAt(node.from).number !== state.doc.lineAt(node.to).number;

/**
 * Inline math on a single line: a replace decoration within the line,
 * rendered for the viewport.
 */
const inlineMath: PreviewRenderer = {
  nodes: ["InlineMath"],
  // Both math renderers name InlineMath; the first one that matches draws it.
  matches: (node, state) => !isMultiLine(node, { state }),
  render(node, cx) {
    if (!isMultiLine(node, cx)) renderInline(node, cx);
    return false;
  },
};

/**
 * Math blocks, and inline math that spans lines: replacing a line break is
 * only allowed from state, so these are block-scope renderers. A math block
 * is replaced as whole lines by a display formula until the selection
 * touches one of its lines.
 */
const blockMath: PreviewRenderer = {
  nodes: ["BlockMath", "InlineMath"],
  scope: "block",
  matches: (node, state) => node.name !== "InlineMath" || isMultiLine(node, { state }),
  render(node, cx) {
    if (node.name === "InlineMath") {
      if (isMultiLine(node, cx)) renderInline(node, cx);
      return false;
    }
    if (cx.touchesSelectedLines(node.from, node.to)) return false;
    const doc = cx.state.doc;
    const from = doc.lineAt(node.from).from;
    const to = doc.lineAt(node.to).to;
    const firstText = node.getChild("MathText");
    const cursor = firstText ? firstText.from : node.from;
    const widget = new MathWidget(mathSource(node, doc), true, cursor - from);
    cx.add(from, to, Decoration.replace({ widget, block: true }));
    return false;
  },
};

const mathTheme = EditorView.baseTheme({
  [`.${mathClass}`]: { cursor: "pointer" },
  [`.${mathClass}-block`]: { padding: "0.5em 0", textAlign: "center", overflowX: "auto" },
  [`.${mathClass}-block .katex-display`]: { margin: "0" },
  [`.${mathClass}-error`]: {
    color: "var(--mint-error-fg)",
    fontFamily: "var(--mint-font-code, monospace)",
    fontSize: "0.9em",
  },
});

/**
 * Math in live preview: KaTeX-rendered formulas for `$…$` and `$$…$$`.
 * Registered whether or not the dialect enables math: without it there are
 * no math nodes to render.
 */
export function mathPreview(): Extension {
  return [previewRenderer.of(inlineMath), previewRenderer.of(blockMath), mathTheme];
}
