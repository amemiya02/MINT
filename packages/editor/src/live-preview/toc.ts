import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { type OutlineHeading, outline, sameOutline } from "../outline.ts";
import { type PreviewRenderer, previewRenderer } from "./preview.ts";

/** Class of the rendered `[TOC]` block. */
const tocClass = "cm-mint-toc";

/**
 * The table of contents a `[TOC]` line stands for: one link per heading of
 * the document, indented by level. Clicking a link moves the cursor to the
 * heading.
 */
class TocWidget extends WidgetType {
  constructor(readonly headings: readonly OutlineHeading[]) {
    super();
  }

  override eq(other: TocWidget): boolean {
    return sameOutline(other.headings, this.headings);
  }

  toDOM(view: EditorView): HTMLElement {
    const nav = document.createElement("nav");
    nav.className = tocClass;
    for (const heading of this.headings) {
      const link = document.createElement("a");
      link.className = `${tocClass}-entry`;
      link.dataset.level = String(heading.level);
      link.style.paddingInlineStart = `${heading.level - 1}em`;
      link.textContent = heading.text;
      link.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        view.dispatch({ selection: { anchor: heading.from }, scrollIntoView: true });
        view.focus();
      });
      nav.append(link);
    }
    return nav;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const renderer: PreviewRenderer = {
  nodes: ["TableOfContents"],
  scope: "block",
  render(node, cx) {
    if (cx.touchesSelectedLines(node.from, node.to)) return false;
    const line = cx.state.doc.lineAt(node.from);
    const widget = new TocWidget(outline(cx.state, false));
    cx.add(line.from, line.to, Decoration.replace({ widget, block: true }));
    return false;
  },
};

const theme = EditorView.baseTheme({
  [`.${tocClass}`]: {
    display: "flex",
    flexDirection: "column",
    padding: "0.4em 0.8em",
    borderLeft: "3px solid var(--mint-border, #d0d7de)",
  },
  [`.${tocClass}-entry`]: {
    color: "var(--mint-link, #2f7d6d)",
    cursor: "pointer",
    textDecoration: "none",
  },
  [`.${tocClass}-entry:hover`]: { textDecoration: "underline" },
});

/**
 * `[TOC]` lines (extended syntax) rendered as a table of contents. Registered
 * whether or not the dialect enables it: without it there are no
 * `TableOfContents` nodes to render.
 */
export const tableOfContents: Extension = [previewRenderer.of(renderer), theme];
