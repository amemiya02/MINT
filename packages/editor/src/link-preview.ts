import { EditorState } from "@codemirror/state";
import { type Dialect, matchingHeadings, renderHtml } from "@mint/markdown";
import { markdownSupport } from "./dialect.ts";
import { parseFileText } from "./file-text.ts";
import { outline } from "./outline.ts";

/** Render a linked document or the section that following the same link would reveal. */
export function renderLinkPreview(
  text: string,
  dialect: Dialect,
  fragment?: string,
): { html: string } | { error: "ambiguousHeading" | "missingHeading"; fragment: string } {
  if (!fragment) return { html: renderHtml(text, dialect) };
  const { doc } = parseFileText(text);
  const state = EditorState.create({ doc, extensions: markdownSupport(dialect) });
  const headings = outline(state, true);
  const matches = matchingHeadings(headings, fragment);
  const first = matches[0];
  if (!first || matches.length > 1)
    return { error: first ? "ambiguousHeading" : "missingHeading", fragment };

  const next = headings.find((h) => h.from > first.from && h.level <= first.level);
  return {
    html: renderHtml(text, dialect, {
      from: doc.lineAt(first.from).number,
      to: next ? doc.lineAt(next.from).number : doc.lines + 1,
    }),
  };
}
