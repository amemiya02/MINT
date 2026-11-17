import type { Element, ElementContent, Root as HastRoot, Nodes, Parents } from "hast";
import { toHtml } from "hast-util-to-html";
import type { Handle, State } from "hast-util-to-mdast";
import type { Nodes as MdastNodes, Parent, PhrasingContent } from "mdast";
import type {
  Info,
  Handle as StringifyHandle,
  Options as StringifyOptions,
  State as StringifyState,
} from "mdast-util-to-markdown";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkStringify from "remark-stringify";
import { type PluggableList, unified } from "unified";
import type { Dialect } from "./dialect.ts";

/** Extended-syntax inline marks (`==…==`, `^…^`, `~…~`); only produced when the dialect enables them. */
interface Mark extends Parent {
  type: "mark";
  children: PhrasingContent[];
}
interface Superscript extends Parent {
  type: "superscript";
  children: PhrasingContent[];
}
interface Subscript extends Parent {
  type: "subscript";
  children: PhrasingContent[];
}
type ExtendedMark = Mark | Superscript | Subscript;

declare module "mdast" {
  interface PhrasingContentMap {
    mark: Mark;
    superscript: Superscript;
    subscript: Subscript;
  }
  interface RootContentMap {
    mark: Mark;
    superscript: Superscript;
    subscript: Subscript;
  }
}

/**
 * Convert HTML (typically rich text from the clipboard: a web page, Google
 * Docs, Word, MINT's own export) into Markdown that uses exactly the syntax
 * enabled in `dialect`. Constructs the dialect lacks degrade to their text
 * (or, for tables without GFM, to an HTML block), never to foreign syntax.
 *
 * Runs without a DOM, so it serves the editor's paste handling and any
 * tooling alike. The output is normalised Markdown for a new snippet; it is
 * never used to rewrite existing document text.
 */
export function htmlToMarkdown(html: string, dialect: Dialect): string {
  const syntax: PluggableList = [];
  if (dialect.gfm) syntax.push(remarkGfm);
  if (dialect.math) syntax.push(remarkMath);
  const stringify: StringifyOptions = {
    bullet: "-",
    emphasis: "*",
    strong: "*",
    rule: "-",
    fences: true,
    handlers: { mark: wrapIn("=="), superscript: wrapIn("^"), subscript: wrapIn("~") },
  };
  const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(() => cleanClipboardHtml)
    .use(rehypeRemark, { handlers: handlersFor(dialect) })
    .use(() => tightLists)
    .use(syntax)
    .use(remarkStringify, stringify);
  const markdown = String(processor.processSync(html));
  return markdown.trim() === "" ? "" : markdown;
}

function wrapIn(marker: string): StringifyHandle {
  return (node: ExtendedMark, _parent: unknown, state: StringifyState, info: Info) => {
    const inner = state.containerPhrasing(node, {
      ...info,
      before: marker.slice(-1),
      after: marker[0] ?? "",
    });
    return marker + inner + marker;
  };
}

/**
 * Lists stay tight (no blank lines between items) unless an item holds more
 * than one block besides nested lists, as with several paragraphs.
 */
function tightLists(node: MdastNodes): void {
  if (node.type === "list") {
    const loose = node.children.some(
      (item) => item.children.filter((child) => child.type !== "list").length > 1,
    );
    node.spread = loose;
    for (const item of node.children) item.spread = loose;
  }
  if ("children" in node) for (const child of node.children) tightLists(child);
}

// --- Clipboard clean-up, on the HTML tree before conversion.

function cleanClipboardHtml(tree: HastRoot): void {
  clean(tree);
}

function clean(parent: Parents): void {
  const next: ElementContent[] = [];
  for (const child of parent.children as ElementContent[]) {
    if (child.type !== "element") {
      next.push(child);
      continue;
    }
    // The newline Safari/macOS appends to copied ranges.
    if (child.tagName === "br" && classes(child).includes("Apple-interchange-newline")) continue;
    clean(child);
    // Google Docs wraps the whole copy in <b style="font-weight:normal" id="docs-internal-guid-…">.
    if (child.tagName === "b" && /^docs-internal-guid/.test(String(child.properties.id ?? ""))) {
      next.push(...child.children);
      continue;
    }
    next.push(styledAsFormatting(child));
  }
  (parent as { children: ElementContent[] }).children = next;
}

/** Word and Google Docs express formatting with inline styles on spans; turn them into elements. */
function styledAsFormatting(element: Element): Element {
  if (element.tagName !== "span") return element;
  const style = String(element.properties.style ?? "").toLowerCase();
  const wrappers: string[] = [];
  if (/font-weight\s*:\s*(bold|[6-9]00)/.test(style)) wrappers.push("strong");
  if (/font-style\s*:\s*italic/.test(style)) wrappers.push("em");
  if (/text-decoration[\w-]*\s*:[^;]*line-through/.test(style)) wrappers.push("del");
  if (/vertical-align\s*:\s*super/.test(style)) wrappers.push("sup");
  if (/vertical-align\s*:\s*sub\b/.test(style)) wrappers.push("sub");
  return wrappers.reduceRight<Element>(
    (inner, tagName) => ({ type: "element", tagName, properties: {}, children: [inner] }),
    element,
  );
}

// --- Element handlers that follow the dialect.

function handlersFor(dialect: Dialect): Record<string, Handle> {
  const children: Handle = (state, node) => state.all(node);
  const extended = (type: ExtendedMark["type"], enabled: boolean): Handle =>
    enabled
      ? (state, node) => {
          const result: ExtendedMark = { type, children: state.all(node) as PhrasingContent[] };
          state.patch(node, result);
          return result;
        }
      : children;
  const { extended: ext } = dialect;
  return {
    span: (state, node) => mathFrom(state, node, dialect) ?? state.all(node),
    math: (state, node) => mathFrom(state, node, dialect) ?? state.all(node),
    mark: extended("mark", ext.highlight),
    sup: extended("superscript", ext.superscript),
    sub: extended("subscript", ext.subscript),
    ...(dialect.gfm
      ? {}
      : {
          del: children,
          s: children,
          strike: children,
          input: () => undefined,
          table: (state, node) => {
            const result = { type: "html" as const, value: toHtml(bareTable(node)) };
            state.patch(node, result);
            return result;
          },
        }),
  };
}

/**
 * A formula rendered by KaTeX (`.katex`, `.katex-display`) or written as
 * MathML with a TeX annotation, turned back into its TeX source.
 */
function mathFrom(state: State, node: Element, dialect: Dialect) {
  const cls = classes(node);
  const display =
    cls.includes("katex-display") ||
    (node.tagName === "math" && node.properties.display === "block");
  if (!(display || cls.includes("katex") || node.tagName === "math")) return undefined;
  const tex = annotation(node);
  if (tex === undefined) return undefined;
  const result = dialect.math
    ? display
      ? { type: "math" as const, value: tex }
      : { type: "inlineMath" as const, value: tex }
    : { type: "text" as const, value: tex };
  state.patch(node, result);
  return result;
}

function annotation(node: Nodes): string | undefined {
  if (node.type === "element" && node.tagName === "annotation") {
    if (node.properties.encoding !== "application/x-tex") return undefined;
    return node.children
      .map((child) => (child.type === "text" ? child.value : ""))
      .join("")
      .trim();
  }
  if (!("children" in node)) return undefined;
  for (const child of node.children) {
    const found = annotation(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A table without the clipboard's styling attributes, for an HTML block. */
function bareTable(node: Element): Element {
  const keep = ["align", "colSpan", "rowSpan"];
  return {
    ...node,
    properties: Object.fromEntries(
      Object.entries(node.properties).filter(([key]) => keep.includes(key)),
    ),
    children: node.children.map((child) => (child.type === "element" ? bareTable(child) : child)),
  };
}

function classes(node: Element): string[] {
  const value = node.properties.className;
  return Array.isArray(value) ? value.map(String) : [];
}
