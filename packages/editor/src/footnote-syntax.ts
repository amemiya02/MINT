import type { BlockContext, Element, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";

/**
 * GFM footnotes for the Lezer Markdown parser, which has none built in:
 *
 * - `FootnoteReference`: `[^label]` inline.
 * - `FootnoteDefinition`: `[^label]: text` at the start of a block, plus
 *   continuation lines that are indented or lazily continue the text. The
 *   text is parsed as inline content.
 *
 * Both are made of `FootnoteMark` (`[^`, `]` / `]:`) and `FootnoteLabel`.
 */
const definitionStart = /^\[\^([^\]\s[]+)\]:/;
/** Lines that start another block instead of continuing a definition lazily. */
const blockStart = /^\s{0,3}(?:[#>*+-]|\d{1,9}[.)]|```|~~~|\[\^|<|\||$)/;

const OPEN_BRACKET = 91; // [
const CARET = 94; // ^
const CLOSE_BRACKET = 93; // ]

function parseReference(cx: InlineContext, next: number, pos: number): number {
  if (next !== OPEN_BRACKET || cx.char(pos + 1) !== CARET) return -1;
  let end = pos + 2;
  for (; end < cx.end; end++) {
    const ch = cx.char(end);
    if (ch === CLOSE_BRACKET || ch === OPEN_BRACKET || ch <= 32) break;
  }
  if (end === pos + 2 || cx.char(end) !== CLOSE_BRACKET) return -1;
  return cx.addElement(
    cx.elt("FootnoteReference", pos, end + 1, [
      cx.elt("FootnoteMark", pos, pos + 2),
      cx.elt("FootnoteLabel", pos + 2, end),
      cx.elt("FootnoteMark", end, end + 1),
    ]),
  );
}

function parseDefinition(cx: BlockContext, line: Line): boolean {
  const match = definitionStart.exec(line.text.slice(line.pos));
  if (!match) return false;
  const from = cx.lineStart + line.pos;
  const labelEnd = from + 2 + (match[1] as string).length;
  const bodyFrom = labelEnd + 2;
  let body = line.text.slice(line.pos + match[0].length);
  let to = cx.lineStart + line.text.length;
  const topLevel = cx.parentType().name === "Document";

  while (cx.nextLine()) {
    const rest = line.text.slice(line.pos);
    const indented = line.indent >= 4 && line.next !== -1;
    if (!topLevel || !(indented || !blockStart.test(rest))) break;
    body += `\n${line.text}`;
    to = cx.lineStart + line.text.length;
  }

  const children: Element[] = [
    cx.elt("FootnoteMark", from, from + 2),
    cx.elt("FootnoteLabel", from + 2, labelEnd),
    cx.elt("FootnoteMark", labelEnd, bodyFrom),
    ...cx.parser.parseInline(body, bodyFrom),
  ];
  cx.addElement(cx.elt("FootnoteDefinition", from, to, children));
  return true;
}

export const footnoteSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "FootnoteDefinition", block: true },
    "FootnoteReference",
    "FootnoteMark",
    "FootnoteLabel",
  ],
  parseBlock: [{ name: "FootnoteDefinition", before: "LinkReference", parse: parseDefinition }],
  parseInline: [{ name: "FootnoteReference", before: "Link", parse: parseReference }],
};
