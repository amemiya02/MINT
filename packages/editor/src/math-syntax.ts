import type { Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { BlockContext, Element, Line, MarkdownConfig } from "@lezer/markdown";

/**
 * Lezer syntax for `$…$` inline math and `$$…$$` math blocks.
 *
 * The rules follow micromark-extension-math (remark-math), which the export
 * pipeline uses, so the editor and the export recognise the same formulas:
 *
 * - Inline math works like a code span: a run of `$` opens it and the next
 *   run of exactly the same length closes it; backslashes inside are TeX.
 *   One space of padding on both sides is not part of the formula.
 * - A math block works like a fenced code block: a line starting (after up to
 *   three spaces) with `$$` or more, optionally followed by text without `$`;
 *   it ends at a line holding a run of at least as many `$`, or at the end of
 *   the enclosing container. It can interrupt a paragraph.
 *
 * Nodes: `InlineMath` and `BlockMath`, with `MathMark` children for the
 * dollar runs and, in blocks, `MathText` children for each line of TeX.
 */
const dollar = 36;

/** Length of the opening fence at the line's position, or -1 if the line does not open a math block. */
function openingFence(line: Line): number {
  if (line.next !== dollar || line.indent - line.baseIndent >= 4) return -1;
  let end = line.pos;
  while (end < line.text.length && line.text.charCodeAt(end) === dollar) end++;
  const size = end - line.pos;
  if (size < 2 || line.text.indexOf("$", end) >= 0) return -1;
  return size;
}

/** `Line.depth` (the number of containers the line continues) exists at runtime but is not typed. */
const lineDepth = (line: Line) => (line as unknown as { depth: number }).depth;

function parseBlockMath(cx: BlockContext, line: Line): boolean {
  const size = openingFence(line);
  if (size < 0) return false;
  const from = cx.lineStart + line.pos;
  const fenceIndent = line.indent - line.baseIndent;
  const children: Element[] = [cx.elt("MathMark", from, from + size)];
  while (cx.nextLine() && lineDepth(line) >= cx.depth) {
    let close = line.pos;
    if (line.indent - line.baseIndent < 4) {
      while (close < line.text.length && line.text.charCodeAt(close) === dollar) close++;
    }
    children.push(...line.markers);
    if (close - line.pos >= size && line.skipSpace(close) === line.text.length) {
      children.push(cx.elt("MathMark", cx.lineStart + line.pos, cx.lineStart + close));
      cx.nextLine();
      break;
    }
    // Content lines lose up to the opening fence's indentation.
    let start = line.basePos;
    for (
      let col = 0;
      col < fenceIndent && start < line.text.length && line.text[start] === " ";
      col++
    ) {
      start++;
    }
    children.push(cx.elt("MathText", cx.lineStart + start, cx.lineStart + line.text.length));
  }
  cx.addElement(cx.elt("BlockMath", from, cx.prevLineEnd(), children));
  return true;
}

export const MathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath" },
    { name: "BlockMath", block: true },
    { name: "MathMark" },
    { name: "MathText" },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      before: "FencedCode",
      parse: parseBlockMath,
      endLeaf: (_cx, line) => openingFence(line) >= 0,
    },
  ],
  parseInline: [
    {
      name: "InlineMath",
      before: "InlineCode",
      parse(cx, next, start) {
        if (next !== dollar || (start > cx.offset && cx.char(start - 1) === dollar)) return -1;
        let pos = start + 1;
        while (pos < cx.end && cx.char(pos) === dollar) pos++;
        const size = pos - start;
        for (let run = 0; pos < cx.end; pos++) {
          if (cx.char(pos) !== dollar) {
            run = 0;
            continue;
          }
          run++;
          if (run === size && cx.char(pos + 1) !== dollar) {
            return cx.addElement(
              cx.elt("InlineMath", start, pos + 1, [
                cx.elt("MathMark", start, start + size),
                cx.elt("MathMark", pos + 1 - size, pos + 1),
              ]),
            );
          }
        }
        return -1;
      },
    },
  ],
};

/**
 * The TeX source of an `InlineMath` or `BlockMath` node, as the export
 * pipeline reads it.
 */
export function mathSource(node: SyntaxNode, doc: Text): string {
  if (node.name === "BlockMath") {
    // One line of TeX per document line between the fences; blank lines have no `MathText`.
    const texts = new Map(
      node.getChildren("MathText").map((text) => [doc.lineAt(text.from).number, text]),
    );
    const marks = node.getChildren("MathMark");
    const first = doc.lineAt(node.from).number + 1;
    const close = marks.length > 1 ? marks[marks.length - 1] : undefined;
    const last = close ? doc.lineAt(close.from).number - 1 : doc.lineAt(node.to).number;
    const lines: string[] = [];
    for (let n = first; n <= last; n++) {
      const text = texts.get(n);
      lines.push(text ? doc.sliceString(text.from, text.to) : "");
    }
    return lines.join("\n");
  }
  const [open, close] = node.getChildren("MathMark");
  if (!open || !close) return "";
  const tex = doc.sliceString(open.to, close.from);
  const padded = /^[ \n].*[ \n]$/s.test(tex) && /[^ \n]/.test(tex);
  return padded ? tex.slice(1, -1) : tex;
}
