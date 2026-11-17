/**
 * The single definition of the Markdown dialect MINT understands.
 *
 * Both the editor core (Lezer parser configuration) and the export pipeline
 * (remark plugins) are derived from this object, so editing and exporting
 * always agree on which syntax exists. New syntax switches are added here
 * first; each consumer maps every switch exhaustively, so the type checker
 * points at the places that must learn about a new one.
 */
export interface Dialect {
  /** GitHub Flavored Markdown: tables, task lists, strikethrough, autolinks, footnotes. */
  readonly gfm: boolean;
  /** `$…$` inline math and `$$…$$` math blocks. */
  readonly math: boolean;
  /** ` ```mermaid ` code blocks rendered as diagrams. */
  readonly mermaid: boolean;
  /** A YAML front matter block delimited by `---` at the very start of the document. */
  readonly frontMatter: boolean;
  /**
   * Extended syntax: not CommonMark/GFM and not rendered by mainstream
   * platforms such as GitHub, so each switch is off by default (ADR-0004).
   */
  readonly extended: ExtendedSyntax;
}

export interface ExtendedSyntax {
  /** `[TOC]` table of contents marker. */
  readonly toc: boolean;
  /** `==highlight==`. */
  readonly highlight: boolean;
  /** `^superscript^`. */
  readonly superscript: boolean;
  /** `~subscript~`. */
  readonly subscript: boolean;
}

/** The default dialect (ADR-0004): CommonMark, GFM, math, Mermaid and front matter; no extended syntax. */
export const defaultDialect: Dialect = {
  gfm: true,
  math: true,
  mermaid: true,
  frontMatter: true,
  extended: {
    toc: false,
    highlight: false,
    superscript: false,
    subscript: false,
  },
};
