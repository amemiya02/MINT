import type { Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type PreviewContext, type PreviewRenderer, previewRenderer } from "./preview.ts";

const levels = [1, 2, 3, 4, 5, 6] as const;
const headingLine = levels.map((level) =>
  Decoration.line({
    class: `cm-mint-heading cm-mint-h${level}`,
    attributes: { role: "heading", "aria-level": String(level) },
  }),
);

/** The heading level of an `ATXHeading1`–`6` / `SetextHeading1`–`2` node, or 0. */
export function headingLevel(name: string): number {
  const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
  return match ? Number(match[1]) : 0;
}

function render(node: SyntaxNode, cx: PreviewContext) {
  const level = headingLevel(node.name);
  const decoration = headingLine[level - 1];
  if (!decoration) return;
  const { doc } = cx.state;
  const marks = node.getChildren("HeaderMark");
  // Like a span, the heading's markers are revealed while the selection touches it.
  const revealed = cx.touchesSelection(node.from, node.to);

  if (node.name.startsWith("ATX")) {
    cx.line(node.from, decoration);
    if (revealed) return;
    for (const mark of marks) {
      if (mark.from === node.from) {
        // `## ` — the marker and the space after it.
        const after = doc.sliceString(mark.to, mark.to + 1);
        cx.hide(mark.from, after === " " || after === "\t" ? mark.to + 1 : mark.to);
      } else {
        // Closing `##`, with the spaces before it.
        let from = mark.from;
        while (from > node.from && /[ \t]/.test(doc.sliceString(from - 1, from))) from--;
        cx.hide(from, mark.to);
      }
    }
    return;
  }

  // Setext: the text lines are the heading; the `===` / `---` underline is its marker.
  const underline = marks[marks.length - 1];
  const textEnd = underline ? underline.from - 1 : node.to;
  for (let pos = node.from; pos <= textEnd; ) {
    const line = doc.lineAt(pos);
    cx.line(line.from, decoration);
    pos = line.to + 1;
  }
  if (underline && !revealed) cx.hide(underline.from, underline.to);
}

const renderer: PreviewRenderer = {
  nodes: [...levels.map((l) => `ATXHeading${l}`), "SetextHeading1", "SetextHeading2"],
  render(node, cx) {
    render(node, cx);
    return undefined;
  },
};

// Sizes, color and weight come from the theme's heading classes on the text itself (theme.ts).
const theme = EditorView.baseTheme({
  ".cm-mint-heading": { fontWeight: "bold", lineHeight: "1.4" },
  ".cm-mint-h6": { color: "var(--mint-muted, #6b7280)" },
});

/** Headings: ATX (`## Title`) and setext (`Title` / `===`). */
export const headings: Extension = [previewRenderer.of(renderer), theme];
