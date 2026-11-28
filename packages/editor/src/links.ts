import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "@lezer/markdown";
import { type Dialect, defaultDialect } from "@mint/markdown";
import { dialectParserExtensions } from "./dialect.ts";
import { parseFileText } from "./file-text.ts";
import { linkClass, urlOwners } from "./live-preview/inline-spans.ts";

/** Where a link the user activated points. */
export type LinkTarget =
  /** A URL with a scheme (`https:`, `mailto:`, ...): open it in the browser. */
  | { readonly kind: "external"; readonly url: string }
  /**
   * A local Markdown document, as written in the link (percent-decoded, without
   * query or fragment in the path). An empty path refers to the current
   * document. The host resolves relative paths and the decoded heading fragment.
   */
  | { readonly kind: "document"; readonly path: string; readonly fragment?: string };

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
      const slice = (from: number, to: number) => state.sliceDoc(from, to);
      const destination = destinationOf(node, slice, () => definitions(syntaxTree(state), slice));
      return destination ? text(destination) : null;
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

type Slice = (from: number, to: number) => string;

const normalizeLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

function definitions(tree: Tree, slice: Slice) {
  const urls = new Map<string, SyntaxNode>();
  tree.iterate({
    enter(ref) {
      if (ref.name !== "LinkReference") return;
      const label = ref.node.getChild("LinkLabel");
      const url = ref.node.getChild("URL");
      if (label && url) {
        const name = normalizeLabel(slice(label.from + 1, label.to - 1));
        if (!urls.has(name)) urls.set(name, url);
      }
      return false;
    },
  });
  return urls;
}

function destinationOf(node: SyntaxNode, slice: Slice, lookup: () => Map<string, SyntaxNode>) {
  const url = node.getChild("URL");
  if (url) return url;
  const label = node.getChild("LinkLabel");
  const [start, end] = node.getChildren("LinkMark");
  const name =
    label && label.to - label.from > 2
      ? slice(label.from + 1, label.to - 1)
      : start && end
        ? slice(start.to, end.from)
        : "";
  return lookup().get(normalizeLabel(name));
}

/** Offsets address the original source, including its BOM and line endings. A
 * reference-style occurrence's destination range belongs to its definition. */
export interface DocumentReference {
  readonly from: number;
  readonly to: number;
  readonly destinationFrom: number;
  readonly destinationTo: number;
  readonly target: Extract<LinkTarget, { kind: "document" }>;
  readonly line: number;
  readonly column: number;
  readonly context: string;
}

export function documentReferences(
  source: string,
  dialect: Dialect = defaultDialect,
): DocumentReference[] {
  const { doc } = parseFileText(source);
  const text = doc.toString();
  const tree = parser.configure(dialectParserExtensions(dialect)).parse(text);
  const slice = (from: number, to: number) => text.slice(from, to);
  const urls = definitions(tree, slice);
  const starts = [source.startsWith("\uFEFF") ? 1 : 0];
  for (const br of source.matchAll(/\r\n|\n|\r/g)) starts.push(br.index + br[0].length);
  const offset = (pos: number) => {
    const line = doc.lineAt(pos);
    return (starts[line.number - 1] ?? 0) + pos - line.from;
  };
  const references: DocumentReference[] = [];
  tree.iterate({
    enter(ref) {
      if (ref.name !== "Link") return;
      const url = destinationOf(ref.node, slice, () => urls);
      if (!url) return;
      const target = classify(slice(url.from, url.to));
      if (target?.kind !== "document") return;
      const line = doc.lineAt(ref.from);
      references.push({
        from: offset(ref.from),
        to: offset(ref.to),
        destinationFrom: offset(url.from),
        destinationTo: offset(url.to),
        target,
        line: line.number,
        column: ref.from - line.from + 1,
        context: line.text,
      });
    },
  });
  return references;
}

/** The target of a link destination as written (`<...>` allowed), or `null` if MINT cannot open it. */
export function classify(rawHref: string): LinkTarget | null {
  const href = rawHref.startsWith("<") && rawHref.endsWith(">") ? rawHref.slice(1, -1) : rawHref;
  // A scheme has at least two characters, so `C:\notes\a.md` is a path.
  if (/^[a-z][a-z0-9+.-]+:/i.test(href)) return { kind: "external", url: href };
  const path = decode(href.replace(/[?#].*$/s, ""));
  const hash = href.indexOf("#");
  const fragment = hash < 0 ? "" : decode(href.slice(hash + 1));
  if (/\.(md|markdown)$/i.test(path) || (href.startsWith("#") && fragment)) {
    return fragment ? { kind: "document", path, fragment } : { kind: "document", path };
  }
  return null;
}

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
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
