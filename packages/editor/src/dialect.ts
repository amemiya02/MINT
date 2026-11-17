import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";
import { GFM, type MarkdownConfig, Subscript, Superscript } from "@lezer/markdown";
import type { Dialect, ExtendedSyntax } from "@mint/markdown";
import { FrontMatter } from "./front-matter.ts";

type Switches = Omit<Dialect, "extended"> & ExtendedSyntax;

/**
 * Lezer parser extensions for each dialect switch. The table is exhaustive
 * over the dialect, so adding a switch to the dialect fails type checking
 * until the editor says how to parse it. Switches whose syntax the editor
 * does not parse yet map to no extensions.
 */
const parserExtensions: { readonly [K in keyof Switches]: readonly MarkdownConfig[] } = {
  gfm: GFM, // footnotes: added with the block-structure renderers
  math: [], // added with the math block widget
  mermaid: [], // plain fenced code; rendered by the Mermaid block widget
  frontMatter: [FrontMatter],
  toc: [],
  highlight: [],
  superscript: [Superscript],
  subscript: [Subscript],
};

/** The Lezer extensions a dialect enables. */
export function dialectParserExtensions(dialect: Dialect): MarkdownConfig[] {
  const switches: Switches = { ...dialect, ...dialect.extended };
  return (Object.keys(parserExtensions) as (keyof Switches)[]).flatMap((key) =>
    switches[key] ? parserExtensions[key] : [],
  );
}

/** Markdown language support configured for exactly the syntax in `dialect`. */
export function markdownSupport(dialect: Dialect): Extension {
  return markdown({
    base: commonmarkLanguage,
    extensions: dialectParserExtensions(dialect),
  });
}
