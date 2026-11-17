import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { linkClass, urlOwners } from "./live-preview/inline-spans.ts";

/** Where a link the user activated points. */
export type LinkTarget =
  /** A URL with a scheme (`https:`, `mailto:`, ...): open it in the browser. */
  | { readonly kind: "external"; readonly url: string }
  /**
   * A local Markdown document, as written in the link (percent-decoded, without
   * `#fragment` or `?query`). Relative paths are relative to the current
   * document; resolving them is the host's job.
   */
  | { readonly kind: "document"; readonly path: string };

/** The link target at `pos`, if `pos` is inside a link MINT can open. */
export function linkAt(state: EditorState, pos: number): LinkTarget | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      const href = hrefOf(state, node);
      if (href !== undefined) return href === null ? null : classify(href);
    }
  }
  return null;
}

/** The raw destination of a link node; `undefined` if `node` is not a link. */
function hrefOf(state: EditorState, node: SyntaxNode): string | null | undefined {
  const text = (n: SyntaxNode) => state.sliceDoc(n.from, n.to);
  switch (node.name) {
    case "Link": {
      const url = node.getChild("URL");
      if (url) return text(url);
      const label = node.getChild("LinkLabel");
      const marks = node.getChildren("LinkMark");
      // `[text][ref]` uses the label; `[ref]` and `[ref][]` use the text itself.
      const name =
        label && label.to - label.from > 2
          ? text(label).slice(1, -1)
          : marks[0] && marks[1]
            ? state.sliceDoc(marks[0].to, marks[1].from)
            : null;
      return name === null ? null : referenceDefinition(state, name);
    }
    case "Autolink": {
      const url = node.getChild("URL");
      if (!url) return null;
      const href = text(url);
      return /^[^\s@:/]+@/.test(href) ? `mailto:${href}` : href;
    }
    case "URL": {
      // URLs inside links, images and definitions belong to their parent node.
      if (urlOwners.has(node.parent?.name ?? "")) return undefined;
      const href = text(node);
      if (/^www\./i.test(href)) return `http://${href}`;
      return /^[^\s@:/]+@/.test(href) ? `mailto:${href}` : href;
    }
    default:
      return undefined;
  }
}

/** The destination of the `[label]: url` definition matching `name` (case-insensitive, whitespace-collapsed). */
function referenceDefinition(state: EditorState, name: string): string | null {
  const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const wanted = normalize(name);
  let found: string | null = null;
  syntaxTree(state).iterate({
    enter(ref) {
      if (found !== null) return false;
      if (ref.name !== "LinkReference") return ref.name === "Document" ? undefined : false;
      const label = ref.node.getChild("LinkLabel");
      const url = ref.node.getChild("URL");
      if (label && url && normalize(state.sliceDoc(label.from + 1, label.to - 1)) === wanted) {
        found = state.sliceDoc(url.from, url.to);
      }
      return false;
    },
  });
  return found;
}

/** The target of a link destination as written (`<...>` allowed), or `null` if MINT cannot open it. */
export function classify(rawHref: string): LinkTarget | null {
  const href = rawHref.startsWith("<") && rawHref.endsWith(">") ? rawHref.slice(1, -1) : rawHref;
  // A scheme has at least two characters, so `C:\notes\a.md` is a path.
  if (/^[a-z][a-z0-9+.-]+:/i.test(href)) return { kind: "external", url: href };
  const path = decode(href.replace(/[?#].*$/s, ""));
  if (/\.(md|markdown)$/i.test(path)) return { kind: "document", path };
  return null;
}

function decode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Whether a mouse event carries the modifier that opens links: ⌘ on macOS, Ctrl elsewhere. */
export function isOpenLinkClick(event: MouseEvent): boolean {
  return event.button === 0 && (isMac ? event.metaKey : event.ctrlKey);
}

/** Where opened links go: the host's `openLink`, if any. Widgets with links of their own use it too. */
export const linkOpener = Facet.define<
  (link: LinkTarget) => void,
  ((link: LinkTarget) => void) | null
>({ combine: (values) => values[0] ?? null });

/** ⌘-click (Ctrl-click off macOS) on a link hands its target to `open`. */
export function linkOpening(open: (link: LinkTarget) => void): Extension {
  return [
    linkOpener.of(open),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!isOpenLinkClick(event)) return false;
        const element =
          event.target instanceof Element ? event.target.closest(`.${linkClass}`) : null;
        if (!element || !view.contentDOM.contains(element)) return false;
        const target = linkAt(view.state, view.posAtDOM(element, 0));
        if (!target) return false;
        event.preventDefault();
        open(target);
        return true;
      },
    }),
  ];
}
