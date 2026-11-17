import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import type { Dialect } from "./dialect.ts";

/** Render Markdown to an HTML fragment, recognising exactly the syntax enabled in `dialect`. */
export function renderHtml(markdown: string, dialect: Dialect): string {
  const syntax: PluggableList = [];
  const rendering: PluggableList = [];
  // A YAML front matter block is metadata, not content: parsed so it is not rendered.
  if (dialect.frontMatter) syntax.push([remarkFrontmatter, ["yaml"]]);
  if (dialect.gfm) syntax.push(remarkGfm);
  if (dialect.math) {
    syntax.push(remarkMath);
    // A malformed formula is rendered as a KaTeX error message; the export never fails on it.
    rendering.push([rehypeKatex, { throwOnError: false, strict: "ignore" }]);
  }
  const processor = unified()
    .use(remarkParse)
    .use(syntax)
    .use(remarkRehype)
    .use(rendering)
    .use(rehypeStringify);
  return String(processor.processSync(markdown));
}
