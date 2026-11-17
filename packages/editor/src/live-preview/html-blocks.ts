import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { classify, isOpenLinkClick, linkOpener } from "../links.ts";
import { imagePlaceholder, resolveImageSource } from "./images.ts";
import { type PreviewRenderer, previewRenderer } from "./preview.ts";

/**
 * Renders Markdown to an HTML fragment that is safe to put into the DOM (the
 * rendering table cells use, sanitised for the app).
 */
export type SafeHtmlRenderer = (markdown: string) => string;

/** Class on every rendered HTML block. */
export const htmlBlockClass = "cm-mint-html";

/** Image sources the page loads itself; any other `srcset` entry is a local file. */
const webUrl = /^(https?|data|blob):/i;

/**
 * A raw HTML block, rendered. Images load through the host's resolver like
 * Markdown images; a click reveals the source, ⌘/Ctrl-click on a link opens it.
 */
class HtmlWidget extends WidgetType {
  constructor(
    /** Sanitised HTML; empty for a comment. */
    readonly html: string,
    /** Tooltip (a hidden comment's text). */
    readonly title: string,
  ) {
    super();
  }

  override eq(other: HtmlWidget): boolean {
    return other.html === this.html && other.title === this.title;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = this.html ? htmlBlockClass : `${htmlBlockClass} ${htmlBlockClass}-hidden`;
    if (this.title) dom.title = this.title;
    // A template's content is inert: no image loads before its source is resolved.
    const template = document.createElement("template");
    template.innerHTML = this.html;
    const content = template.content;
    // Local `srcset` files cannot go through the host's resolver; the `<img>` fallback is used instead.
    for (const source of content.querySelectorAll("source")) {
      const urls = (source.getAttribute("srcset") ?? "")
        .split(",")
        .map((entry) => entry.trim().split(/\s+/)[0] ?? "");
      if (urls.some((url) => url && !webUrl.test(url))) source.remove();
    }
    for (const img of content.querySelectorAll("img")) {
      const placeholder = () => {
        img.replaceWith(imagePlaceholder(img.alt, img.getAttribute("src") ?? ""));
        view.requestMeasure();
      };
      const src = img.getAttribute("src");
      const url = src ? resolveImageSource(view.state, src) : null;
      if (url === null) {
        placeholder();
        continue;
      }
      img.setAttribute("src", url);
      img.draggable = false;
      img.addEventListener("error", placeholder, { once: true });
      img.addEventListener("load", () => view.requestMeasure(), { once: true });
    }
    dom.append(content);
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (link && dom.contains(link) && isOpenLinkClick(event)) {
        const target = classify(link.getAttribute("href") ?? "");
        const open = view.state.facet(linkOpener);
        if (target && open) open(target);
        return;
      }
      // The cursor at the start of the block's first line reveals its source.
      view.dispatch({ selection: { anchor: view.posAtDOM(dom) }, scrollIntoView: true });
      view.focus();
    });
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * A paragraph that is HTML from start to end, like a line of README badges
 * (`<a href=…><img …></a>`), is rendered as HTML too. HTML within a sentence
 * (`Press <kbd>Ctrl</kbd>`) stays part of the text.
 */
function isHtmlParagraph(node: SyntaxNode): boolean {
  const first = node.firstChild;
  const last = node.lastChild;
  return (
    first?.name === "HTMLTag" &&
    first.from === node.from &&
    last?.name === "HTMLTag" &&
    last.to === node.to
  );
}

/** `render`, remembering its output by source: blocks are rendered again on every selection change. */
function cached(render: SafeHtmlRenderer): SafeHtmlRenderer {
  const cache = new Map<string, string>();
  return (source) => {
    let html = cache.get(source);
    if (html === undefined) {
      html = render(source);
      if (cache.size >= 200) cache.clear();
      cache.set(source, html);
    }
    return html;
  };
}

/**
 * Raw HTML blocks (block widget), and paragraphs made of HTML only: replaced
 * as whole lines by the sanitised HTML until the selection touches one of
 * their lines. HTML comments are hidden the same way. Only blocks directly in
 * the document: within quotes and lists, the lines carry their markers.
 */
function htmlBlocks(renderHtml: SafeHtmlRenderer): PreviewRenderer {
  const render = cached(renderHtml);
  return {
    nodes: ["HTMLBlock", "CommentBlock", "Paragraph"],
    scope: "block",
    matches: (node) =>
      node.parent?.name === "Document" && (node.name !== "Paragraph" || isHtmlParagraph(node)),
    render(node, cx) {
      if (cx.touchesSelectedLines(node.from, node.to)) return false;
      const doc = cx.state.doc;
      const from = doc.lineAt(node.from).from;
      const to = doc.lineAt(node.to).to;
      const source = cx.state.sliceDoc(node.from, node.to);
      const widget =
        node.name === "CommentBlock"
          ? new HtmlWidget("", source)
          : new HtmlWidget(render(source), "");
      cx.add(from, to, Decoration.replace({ widget, block: true }));
      return false;
    },
  };
}

const htmlTheme = EditorView.baseTheme({
  [`.${htmlBlockClass}`]: { padding: "4px 0", cursor: "pointer", overflowX: "auto" },
  [`.${htmlBlockClass} > :first-child`]: { marginTop: "0" },
  [`.${htmlBlockClass} > :last-child`]: { marginBottom: "0" },
  [`.${htmlBlockClass} img`]: { maxWidth: "100%" },
  [`.${htmlBlockClass}-hidden`]: { padding: "0", height: "6px" },
});

/** HTML blocks in live preview, drawn with `render`, which must sanitise. */
export function htmlBlockPreview(render: SafeHtmlRenderer): Extension {
  return [previewRenderer.of(htmlBlocks(render)), htmlTheme];
}
