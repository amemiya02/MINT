/**
 * The single definition of the Markdown dialect MINT understands.
 *
 * Both the editor core (Lezer parser configuration) and the export pipeline
 * (remark plugins) are derived from this object, so editing and exporting
 * always agree on which syntax exists. New syntax switches (math, mermaid,
 * front matter, extended syntax, ...) are added here first.
 */
export interface Dialect {
  /** GitHub Flavored Markdown: tables, task lists, strikethrough, autolinks, footnotes. */
  readonly gfm: boolean;
}

export const defaultDialect: Dialect = {
  gfm: true,
};
