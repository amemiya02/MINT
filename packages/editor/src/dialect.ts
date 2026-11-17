import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import { GFM, type MarkdownConfig, Subscript, Superscript } from "@lezer/markdown";
import type { Dialect, ExtendedSyntax } from "@mint/markdown";
import { footnoteSyntax } from "./footnote-syntax.ts";
import { MathSyntax } from "./math-syntax.ts";

type Switches = Omit<Dialect, "extended"> & ExtendedSyntax;

/**
 * Lezer parser extensions for each dialect switch. The table is exhaustive
 * over the dialect, so adding a switch to the dialect fails type checking
 * until the editor says how to parse it. Switches whose syntax the editor
 * does not parse yet map to no extensions.
 */
const parserExtensions: { readonly [K in keyof Switches]: readonly MarkdownConfig[] } = {
  gfm: [...GFM, footnoteSyntax],
  math: [MathSyntax],
  mermaid: [], // plain fenced code; rendered by the Mermaid block widget
  frontMatter: [], // added with the front matter block widget
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
    // Fenced code is highlighted by its language; grammars load on first use.
    codeLanguages: languages,
    // Enter/Backspace on list and quote markup: see markup-continuation.ts.
    addKeymap: false,
    extensions: dialectParserExtensions(dialect),
  });
}
