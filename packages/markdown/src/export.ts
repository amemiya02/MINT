import type { Element, Root } from "hast";
import type { Root as MarkdownRoot, Nodes, Parent } from "mdast";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, type Plugin, unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import type { Dialect, ExtendedSyntax } from "./dialect.ts";
import { highlightFromMarkdown, highlightSyntax } from "./syntax/highlight.ts";
import { syntaxPlugin } from "./syntax/plugin.ts";
import {
  subscriptFromMarkdown,
  subscriptSyntax,
  superscriptFromMarkdown,
  superscriptSyntax,
} from "./syntax/sub-super.ts";
import { tocFromMarkdown, tocPlugins, tocSyntax } from "./syntax/toc.ts";

/**
 * remark plugins for each extended syntax switch. The table is exhaustive, so
 * a new switch fails type checking until the export says how to parse it.
 */
const extendedPlugins: { readonly [K in keyof ExtendedSyntax]: PluggableList } = {
  toc: [syntaxPlugin(tocSyntax, tocFromMarkdown), ...tocPlugins],
  highlight: [syntaxPlugin(highlightSyntax, highlightFromMarkdown)],
  superscript: [syntaxPlugin(superscriptSyntax, superscriptFromMarkdown)],
  subscript: [syntaxPlugin(subscriptSyntax, subscriptFromMarkdown)],
};

/** The remark plugins that parse exactly the syntax enabled in `dialect`. */
function syntaxPlugins(dialect: Dialect): PluggableList {
  const plugins: PluggableList = [];
  // Front matter is metadata: recognised (so it is not read as a rule and a heading) but not rendered.
  if (dialect.frontMatter) plugins.push([remarkFrontmatter, ["yaml"]]);
  // GFM strikethrough is `~~…~~` only, as in the editor; a single `~` belongs to subscript.
  if (dialect.gfm) plugins.push([remarkGfm, { singleTilde: false }]);
  if (dialect.math) plugins.push(remarkMath);
  for (const key of Object.keys(extendedPlugins) as (keyof ExtendedSyntax)[]) {
    if (dialect.extended[key]) plugins.push(...extendedPlugins[key]);
  }
  return plugins;
}

/**
 * What may reach the app's DOM: GitHub's sanitation (no scripts, event handlers,
 * `javascript:` URLs, frames or styles; ids are prefixed with `user-content-` so
 * they cannot clobber globals) plus the elements MINT's own syntax renders to.
 * Presentational HTML of READMEs (`align`, `width`, `height`, `<details>`,
 * `<kbd>`, `<picture>`...) is kept, and so are `data:` images.
 * KaTeX renders after sanitation, from the math code it keeps here.
 */
const appSchema: SanitizeSchema = {
  ...defaultSchema,
  // Inline images (`data:`) are only ever loaded as images; they cannot run code there.
  protocols: { ...defaultSchema.protocols, src: [...(defaultSchema.protocols?.src ?? []), "data"] },
  // A `<style>` would restyle the whole app; drop it with its text rather than unwrapping it.
  strip: [...(defaultSchema.strip ?? []), "style"],
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "nav"],
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
    nav: [["className", "toc"]],
  },
};

/** Render Markdown to an HTML fragment, recognising exactly the syntax enabled in `dialect`. */
function render(
  markdown: string,
  dialect: Dialect,
  clean: PluggableList,
  select: PluggableList = [],
): string {
  const rendering: PluggableList = [];
  if (dialect.math) {
    // A malformed formula is rendered as a KaTeX error message; the export never fails on it.
    rendering.push([rehypeKatex, { throwOnError: false, strict: "ignore" }]);
  }
  const processor = unified()
    .use(remarkParse)
    .use(syntaxPlugins(dialect))
    .use(select)
    // HTML in the document is kept (and cleaned below); ids get their prefix from the cleaning.
    .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: "" })
    .use(rehypeRaw)
    .use(clean)
    .use(rendering)
    .use(rehypeStringify);
  return String(processor.processSync(markdown));
}

interface SectionLines {
  /** One-based lines. The end is exclusive. */
  from: number;
  to: number;
}

/** Leave reference definitions available even when they are outside the selected section. */
const selectLines: Plugin<[SectionLines], MarkdownRoot> =
  ({ from, to }) =>
  (tree) => {
    function keep(node: Nodes): boolean {
      if (node.type === "definition" || node.type === "footnoteDefinition") return true;
      if (node.position && node.position.start.line >= from && node.position.end.line < to)
        return true;
      if (!("children" in node)) return false;
      // A blockquote or list can straddle either section boundary.
      const parent: Parent = node;
      parent.children = parent.children.filter(keep);
      return parent.children.length > 0;
    }
    tree.children = tree.children.filter(keep);
  };

/**
 * Render Markdown to an HTML fragment that is safe to put into the app's DOM,
 * recognising exactly the syntax enabled in `dialect`. HTML written in the
 * document is kept as far as it is harmless (see `appSchema`).
 */
export function renderHtml(markdown: string, dialect: Dialect, lines?: SectionLines): string {
  return render(markdown, dialect, cleanForApp, lines ? [[selectLines, lines]] : []);
}

/**
 * Render Markdown to the HTML fragment of an exported document. HTML written
 * in the document is kept as written, except what would run code when the
 * file is opened: `<script>` elements, `on…` event handler attributes and
 * `javascript:` URLs are removed.
 */
export function renderExportHtml(markdown: string, dialect: Dialect): string {
  return render(markdown, dialect, [withoutScripts]);
}

/** Sanitation prefixed every id; point the document's own `#fragment` links at the prefixed ids. */
const linkPrefixedIds: Plugin<[], Root> = () => (tree) => {
  const prefix = defaultSchema.clobberPrefix ?? "";
  const ids = new Set<string>();
  visit(tree, "element", (node) => {
    if (typeof node.properties.id === "string") ids.add(node.properties.id);
  });
  visit(tree, "element", (node) => {
    const href = node.properties.href;
    if (typeof href !== "string" || !href.startsWith("#")) return;
    const id = decodeURIComponent(href.slice(1));
    if (!ids.has(id) && ids.has(prefix + id)) node.properties.href = `#${prefix}${id}`;
  });
};

const cleanForApp: PluggableList = [[rehypeSanitize, appSchema], linkPrefixedIds];

const urlProperties = ["href", "src", "action", "formAction", "xLinkHref", "poster", "cite"];

function withoutControlCharacters(text: string): string {
  return [...text].filter((c) => c.charCodeAt(0) > 0x20).join("");
}

const withoutScripts: Plugin<[], Root> = () => (tree) => {
  visit(tree, "element", (node: Element, index, parent) => {
    if (node.tagName === "script" && parent && index !== undefined) {
      parent.children.splice(index, 1);
      return [SKIP, index];
    }
    for (const [key, value] of Object.entries(node.properties)) {
      const isHandler = /^on/i.test(key);
      const isScriptUrl =
        urlProperties.includes(key) &&
        // Browsers ignore control characters and spaces in a scheme (`java\tscript:`).
        /^javascript:/i.test(withoutControlCharacters(String(value)));
      if (isHandler || isScriptUrl) delete node.properties[key];
    }
    return undefined;
  });
};
