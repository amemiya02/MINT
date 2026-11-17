import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Dialect } from "./dialect.ts";

/** Render Markdown to an HTML fragment, recognising exactly the syntax enabled in `dialect`. */
export function renderHtml(markdown: string, dialect: Dialect): string {
  const processor = unified().use(remarkParse);
  if (dialect.gfm) processor.use(remarkGfm);
  return String(processor.use(remarkRehype).use(rehypeStringify).processSync(markdown));
}
