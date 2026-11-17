import { type EditorState, type Extension, Facet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type PreviewContext, type PreviewRenderer, previewRenderer } from "./preview.ts";

/**
 * Turns the path of a local image (as written in the document, angle brackets
 * removed and percent-decoded) into a URL the page can load, or `null` if it
 * cannot be shown. Images with a URL scheme (`https:`, `data:`...) never
 * reach it.
 */
export type ImageUrlResolver = (path: string) => string | null;

/** How live preview resolves local image paths; the host's resolver, if any. */
export const imageUrlResolver = Facet.define<ImageUrlResolver, ImageUrlResolver>({
  combine: (values) => values[0] ?? ((path) => path),
});

/** Schemes the page loads by itself; everything else is a file path for the host. */
const webUrl = /^(https?|data|blob):/i;

/** The destination of an image as a file path or URL: `<...>` removed, percent-decoded. */
export function imagePath(destination: string): string {
  const raw =
    destination.startsWith("<") && destination.endsWith(">")
      ? destination.slice(1, -1)
      : destination;
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}

function resolveUrl(state: EditorState, destination: string): string | null {
  if (webUrl.test(destination)) return destination;
  return state.facet(imageUrlResolver)(imagePath(destination));
}

/** The visible label of an image: its alt text as written. */
function altText(state: EditorState, node: SyntaxNode): string {
  const marks = node.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  return open && close ? state.sliceDoc(open.to, close.from) : "";
}

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string | null,
    readonly alt: string,
    readonly title: string,
    readonly block: boolean,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return (
      other.url === this.url &&
      other.alt === this.alt &&
      other.title === this.title &&
      other.block === this.block
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement(this.block ? "div" : "span");
    wrapper.className = this.block ? "cm-mint-image cm-mint-image-block" : "cm-mint-image";
    const placeholder = () => {
      const missing = document.createElement("span");
      missing.className = "cm-mint-image-missing";
      missing.setAttribute("role", "img");
      missing.setAttribute("aria-label", this.alt || this.title);
      missing.title = this.title;
      missing.textContent = this.alt || this.title;
      wrapper.replaceChildren(missing);
      view.requestMeasure();
    };
    if (this.url === null) {
      placeholder();
      return wrapper;
    }
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    if (this.title) img.title = this.title;
    img.draggable = false;
    img.addEventListener("error", placeholder, { once: true });
    img.addEventListener("load", () => view.requestMeasure(), { once: true });
    wrapper.append(img);
    return wrapper;
  }

  // Let the editor handle clicks: they place the cursor on the image, which reveals its source.
  override ignoreEvent(): boolean {
    return false;
  }
}

function widgetFor(state: EditorState, node: SyntaxNode, block: boolean): ImageWidget | null {
  const url = node.getChild("URL");
  if (!url) return null;
  const destination = state.sliceDoc(url.from, url.to);
  const title = node.getChild("LinkTitle");
  return new ImageWidget(
    resolveUrl(state, destination),
    altText(state, node),
    // The tooltip: the Markdown title if there is one, otherwise the path.
    title ? state.sliceDoc(title.from + 1, title.to - 1) : imagePath(destination),
    block,
  );
}

/** Whether the image is all there is on its lines (so it is shown as a block). */
function standsAlone(state: EditorState, node: SyntaxNode): { from: number; to: number } | null {
  const parent = node.parent;
  if (parent?.name !== "Paragraph") return null;
  const from = state.doc.lineAt(node.from).from;
  const to = state.doc.lineAt(node.to).to;
  const text = state.sliceDoc(from, to);
  return text.trim() === state.sliceDoc(node.from, node.to) ? { from, to } : null;
}

function renderImage(node: SyntaxNode, cx: PreviewContext) {
  const { state } = cx;
  const alone = standsAlone(state, node);
  if (alone) {
    const widget = widgetFor(state, node, true);
    if (!widget) return;
    if (cx.touchesSelectedLines(alone.from, alone.to)) {
      // Editing the source: keep the picture in view below it.
      cx.add(alone.to, alone.to, Decoration.widget({ widget, block: true, side: 1 }));
    } else {
      cx.add(alone.from, alone.to, Decoration.replace({ widget, block: true }));
    }
    return;
  }
  if (cx.touchesSelection(node.from, node.to)) return;
  const widget = widgetFor(state, node, false);
  if (widget) cx.add(node.from, node.to, Decoration.replace({ widget }));
}

/**
 * Images (block widget): an image alone on its lines replaces them as a block;
 * an image within text is replaced inline. The source shows while the cursor
 * is on it.
 */
const images: PreviewRenderer = {
  nodes: ["Image"],
  scope: "block",
  render(node, cx) {
    renderImage(node, cx);
    return false;
  },
};

const imageTheme = EditorView.baseTheme({
  ".cm-mint-image img": { maxWidth: "100%", verticalAlign: "bottom" },
  ".cm-mint-image-block": { padding: "4px 0" },
  ".cm-mint-image-block img": { display: "block", maxHeight: "80vh" },
  ".cm-mint-image-missing": {
    display: "inline-block",
    padding: "2px 8px",
    border: "1px dashed var(--mint-marker, #8a9099)",
    borderRadius: "3px",
    color: "var(--mint-marker, #8a9099)",
    fontSize: "0.9em",
  },
});

/** Image rendering for live preview: the renderer plus its styles. */
export function imagePreview(): Extension {
  return [previewRenderer.of(images), imageTheme];
}
