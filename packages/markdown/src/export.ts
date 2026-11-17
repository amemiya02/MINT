import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
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

/** Render Markdown to an HTML fragment, recognising exactly the syntax enabled in `dialect`. */
export function renderHtml(markdown: string, dialect: Dialect): string {
  const rendering: PluggableList = [];
  if (dialect.math) {
    // A malformed formula is rendered as a KaTeX error message; the export never fails on it.
    rendering.push([rehypeKatex, { throwOnError: false, strict: "ignore" }]);
  }
  const processor = unified()
    .use(remarkParse)
    .use(syntaxPlugins(dialect))
    .use(remarkRehype)
    .use(rendering)
    .use(rehypeStringify);
  return String(processor.processSync(markdown));
}
