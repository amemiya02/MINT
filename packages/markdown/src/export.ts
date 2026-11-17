import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Dialect } from "./dialect.ts";

/** Render Markdown to an HTML fragment, recognising exactly the syntax enabled in `dialect`. */
export function renderHtml(markdown: string, dialect: Dialect): string {
  const processor = unified().use(remarkParse);
  // Front matter is metadata: recognised (so it is not read as a rule and a heading) but not rendered.
  if (dialect.frontMatter) processor.use(remarkFrontmatter, ["yaml"]);
  if (dialect.gfm) processor.use(remarkGfm);
  return String(processor.use(remarkRehype).use(rehypeStringify).processSync(markdown));
}
