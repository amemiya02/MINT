import { tags } from "@lezer/highlight";
import type { BlockContext, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";

/**
 * Lezer syntax for the extended syntax switches (ADR-0004). The rules are the
 * export pipeline's (packages/markdown/src/syntax/), so the editor and the
 * export recognise the same spans; the conformance samples in
 * test/extended-syntax.test.ts check that they agree.
 */

const EQUALS = 61; // =
const BACKSLASH = 92; // \
const CARET = 94; // ^
const TILDE = 126; // ~

const Punctuation = /[\p{S}\p{P}]/u;

/**
 * `==highlight==`, with the rules of GFM strikethrough: a run of exactly two
 * `=` opens when left-flanking and closes when right-flanking; the text in
 * between is ordinary inline Markdown. Nodes: `Highlight` with `HighlightMark`s.
 */
const HighlightDelimiter = { resolve: "Highlight", mark: "HighlightMark" };

export const highlightSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": tags.special(tags.content) } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) {
          return -1;
        }
        // Only at the start of a run of `=` (an escaped `=` before it does not count).
        if (cx.char(pos - 1) === EQUALS && cx.char(pos - 2) !== BACKSLASH) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        return cx.addDelimiter(
          HighlightDelimiter,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};

const isSpace = (ch: number) => ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === -1;
const isAsciiPunctuation = (ch: number) =>
  (ch >= 33 && ch <= 47) ||
  (ch >= 58 && ch <= 64) ||
  (ch >= 91 && ch <= 96) ||
  (ch >= 123 && ch <= 126);

/**
 * `^superscript^` / `~subscript~`, Pandoc style: a single marker (not next to
 * the same marker) opens; the text runs to the next marker without spaces or
 * line breaks, a backslash escapes the ASCII punctuation after it, and the
 * text is not parsed further. Nodes: `Superscript` / `Subscript`, with
 * `SuperscriptMark` / `SubscriptMark` children.
 */
function script(marker: number, node: string, mark: string): MarkdownConfig {
  return {
    defineNodes: [
      { name: node, style: tags.special(tags.content) },
      { name: mark, style: tags.processingInstruction },
    ],
    parseInline: [
      {
        name: node,
        parse(cx: InlineContext, next: number, pos: number) {
          if (next !== marker || cx.char(pos - 1) === marker) return -1;
          const first = cx.char(pos + 1);
          if (first === marker || isSpace(first)) return -1;
          for (let i = pos + 1; i < cx.end; i++) {
            const ch = cx.char(i);
            if (isSpace(ch)) return -1;
            if (ch === marker) {
              return cx.addElement(
                cx.elt(node, pos, i + 1, [cx.elt(mark, pos, pos + 1), cx.elt(mark, i, i + 1)]),
              );
            }
            if (ch === BACKSLASH && isAsciiPunctuation(cx.char(i + 1))) i++;
          }
          return -1;
        },
      },
    ],
  };
}

export const superscriptSyntax = script(CARET, "Superscript", "SuperscriptMark");
export const subscriptSyntax = script(TILDE, "Subscript", "SubscriptMark");

/**
 * `[TOC]`: a line holding only `[TOC]` (up to three spaces of indentation,
 * trailing spaces allowed) that starts a block; it never interrupts a
 * paragraph. Node: `TableOfContents`.
 */
const tocLine = /^\[TOC\][ \t]*$/;

export const tocSyntax: MarkdownConfig = {
  defineNodes: [{ name: "TableOfContents", block: true, style: tags.meta }],
  parseBlock: [
    {
      name: "TableOfContents",
      before: "LinkReference",
      parse(cx: BlockContext, line: Line) {
        if (line.indent - line.baseIndent >= 4 || !tocLine.test(line.text.slice(line.pos))) {
          return false;
        }
        const from = cx.lineStart + line.pos;
        cx.addElement(cx.elt("TableOfContents", from, from + 5));
        cx.nextLine();
        return true;
      },
    },
  ],
};
