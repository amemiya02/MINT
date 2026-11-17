import { EditorSelection, type EditorState, type Extension, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type PreviewContext, type PreviewRenderer, previewRenderer } from "./preview.ts";

/** Top-level YAML keys of the front matter, in order: the summary of a folded block. */
function fieldNames(state: EditorState, node: SyntaxNode): string[] {
  const names: string[] = [];
  const first = state.doc.lineAt(node.from).number + 1;
  const last = state.doc.lineAt(node.to).number - 1;
  for (let n = first; n <= last; n++) {
    const key = /^([^\s#:][^:]*):(?:\s|$)/.exec(state.doc.line(n).text)?.[1]?.trim();
    if (key) names.push(key.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return names;
}

/** Where the selection goes to unfold the block: the start of its first field line. */
function unfoldPosition(state: EditorState, node: SyntaxNode): number {
  const opening = state.doc.lineAt(node.from);
  return Math.min(opening.to + 1, node.to);
}

/** Where the selection goes to fold the block: the line after it, if there is one. */
function foldPosition(state: EditorState, node: SyntaxNode): number | undefined {
  const closing = state.doc.lineAt(node.to);
  return closing.number < state.doc.lines ? closing.to + 1 : undefined;
}

function moveSelection(view: EditorView, event: Event, anchor: number) {
  event.preventDefault();
  view.dispatch({ selection: EditorSelection.cursor(anchor), scrollIntoView: true });
  view.focus();
}

/** The folded block: names its fields; pressing it unfolds the block for editing. */
class FoldedFrontMatter extends WidgetType {
  constructor(
    readonly fields: readonly string[],
    readonly unfoldAt: number,
  ) {
    super();
  }
  override eq(other: FoldedFrontMatter) {
    return other.unfoldAt === this.unfoldAt && other.fields.join("\n") === this.fields.join("\n");
  }
  toDOM(view: EditorView) {
    const block = document.createElement("div");
    block.className = "cm-mint-front-matter";
    block.title = "Front Matter";
    const toggle = block.appendChild(document.createElement("span"));
    toggle.className = "cm-mint-front-matter-toggle";
    toggle.textContent = "▸";
    const label = block.appendChild(document.createElement("span"));
    label.className = "cm-mint-front-matter-label";
    label.textContent = "Front Matter";
    const fields = block.appendChild(document.createElement("span"));
    fields.className = "cm-mint-front-matter-fields";
    fields.textContent = this.fields.join(", ");
    block.addEventListener("mousedown", (event) => moveSelection(view, event, this.unfoldAt));
    return block;
  }
  override ignoreEvent() {
    return true;
  }
}

/** The fold control on the opening fence of an unfolded block. */
class FoldButton extends WidgetType {
  constructor(readonly foldAt: number) {
    super();
  }
  override eq(other: FoldButton) {
    return other.foldAt === this.foldAt;
  }
  toDOM(view: EditorView) {
    const button = document.createElement("span");
    button.className = "cm-mint-front-matter-fold";
    button.title = "Fold Front Matter";
    button.textContent = "▾";
    button.addEventListener("mousedown", (event) => moveSelection(view, event, this.foldAt));
    return button;
  }
  override ignoreEvent() {
    return true;
  }
}

const source = Decoration.mark({ class: "cm-mint-front-matter-source" });
const marker = Decoration.mark({ class: "cm-mint-marker" });

/**
 * Whether the selection has been moved since the document was opened. A
 * document opens with the cursor at its start, which is on the front matter;
 * the block stays folded until the selection is moved onto it.
 */
const selectionMoved = StateField.define<boolean>({
  create: () => false,
  update: (moved, tr) => moved || tr.selection !== undefined,
});

function render(node: SyntaxNode, cx: PreviewContext) {
  const { state } = cx;
  const unfolded =
    state.field(selectionMoved, false) === true && cx.touchesSelectedLines(node.from, node.to);
  if (!unfolded) {
    const widget = new FoldedFrontMatter(fieldNames(state, node), unfoldPosition(state, node));
    cx.add(node.from, node.to, Decoration.replace({ widget, block: true }));
    return;
  }
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  for (let n = first.number; n <= last.number; n++) {
    const line = state.doc.line(n);
    cx.add(line.from, line.to, source);
  }
  for (const mark of node.getChildren("FrontMatterMark")) cx.add(mark.from, mark.to, marker);
  const foldAt = foldPosition(state, node);
  if (foldAt !== undefined) {
    const button = new FoldButton(foldAt);
    cx.add(first.to, first.to, Decoration.widget({ widget: button, side: 1 }));
  }
}

/**
 * Front matter block widget: folded into a one-line metadata block naming
 * its fields; unfolded to its YAML source, editable in place, while the
 * selection is in it.
 */
export const frontMatterBlock: PreviewRenderer = {
  nodes: ["FrontMatter"],
  scope: "block",
  render(node, cx) {
    render(node, cx);
    return false;
  },
};

const frontMatterTheme = EditorView.baseTheme({
  ".cm-mint-front-matter": {
    display: "flex",
    gap: "0.5em",
    alignItems: "baseline",
    padding: "2px 8px",
    borderRadius: "4px",
    cursor: "pointer",
    color: "var(--mint-marker, #8a9099)",
    backgroundColor: "var(--mint-code-bg, rgba(127, 127, 127, 0.1))",
    fontFamily: "var(--mint-font-code, monospace)",
    fontSize: "0.9em",
  },
  ".cm-mint-front-matter-label": { fontWeight: "bold" },
  ".cm-mint-front-matter-fields": {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-mint-front-matter-source": {
    fontFamily: "var(--mint-font-code, monospace)",
    backgroundColor: "var(--mint-code-bg, rgba(127, 127, 127, 0.1))",
  },
  ".cm-mint-front-matter-fold": {
    cursor: "pointer",
    marginLeft: "0.5em",
    color: "var(--mint-marker, #8a9099)",
  },
});

/** The front matter block widget, registered with live preview. */
export const frontMatterPreview: Extension = [
  selectionMoved,
  previewRenderer.of(frontMatterBlock),
  frontMatterTheme,
];
