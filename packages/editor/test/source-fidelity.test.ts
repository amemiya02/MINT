// Source fidelity properties, checked through the editor core's public interface:
// text the user did not edit must survive byte for byte.
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, type MintEditor } from "../src/index.ts";

const editors: MintEditor[] = [];
function open(text: string): MintEditor {
  const editor = createEditor({ parent: document.body, text });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

const lineEnding = fc.constantFrom("\n", "\r\n", "\r");
const markdownLine = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.constantFrom(
    "# Heading",
    "- item",
    "* item",
    "1. one",
    "> quote",
    "```",
    "| a | b |",
    "  ",
    "",
  ),
  fc.string({
    unit: fc.constantFrom("*", "_", "`", "#", "-", "|", " ", "a", "中", "\t", "😀"),
    maxLength: 12,
  }),
);

/** A file: optional BOM, lines joined by a single or mixed line ending, optional final newline. */
const fileText = fc
  .record({
    bom: fc.boolean(),
    lines: fc.array(markdownLine, { maxLength: 12 }),
    endings: fc.oneof(
      lineEnding.map((ending) => () => ending),
      fc.infiniteStream(lineEnding).map((stream) => () => stream.next().value),
    ),
    finalNewline: fc.boolean(),
  })
  .map(({ bom, lines, endings, finalNewline }) => {
    let text = bom ? "﻿" : "";
    lines.forEach((line, i) => {
      text += line;
      if (i < lines.length - 1 || finalNewline) text += endings();
    });
    return text;
  });

const insertion = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom("\n", "**", "- ", "中文", "\r\n"),
);

/** Edit as a fraction of the document so it always lands in range. */
const edit = fc.record({
  a: fc.double({ min: 0, max: 1, noNaN: true }),
  b: fc.double({ min: 0, max: 1, noNaN: true }),
  text: insertion,
});

describe("source fidelity", () => {
  it("opening and saving without edits returns the file unchanged", () => {
    fc.assert(
      fc.property(fileText, (text) => {
        expect(open(text).getText()).toBe(text);
      }),
    );
  });

  it("never changes text outside the edited range", () => {
    fc.assert(
      fc.property(fileText, fc.array(edit, { minLength: 1, maxLength: 6 }), (text, edits) => {
        const editor = open(text);
        for (const { a, b, text: inserted } of edits) {
          const before = editor.getText();
          const anchor = Math.round(a * before.length);
          const head = Math.round(b * before.length);
          editor.setSelection({ anchor, head });
          const { anchor: from0, head: to0 } = editor.getSelection();
          const from = Math.min(from0, to0);
          const to = Math.max(from0, to0);

          editor.execute("insertText", inserted);

          const after = editor.getText();
          const insertedLength = after.length - before.length + (to - from);
          expect(after.slice(0, from)).toBe(before.slice(0, from));
          expect(after.slice(from + insertedLength)).toBe(before.slice(to));
          // The inserted text itself only differs in its line endings.
          expect(after.slice(from, from + insertedLength).replace(/\r\n?/g, "\n")).toBe(
            inserted.replace(/\r\n?/g, "\n"),
          );
        }
      }),
    );
  });

  it("undoing every edit restores the original file exactly", () => {
    fc.assert(
      fc.property(fileText, fc.array(edit, { minLength: 1, maxLength: 6 }), (text, edits) => {
        const editor = open(text);
        for (const { a, b, text: inserted } of edits) {
          const length = editor.getText().length;
          editor.setSelection({ anchor: Math.round(a * length), head: Math.round(b * length) });
          editor.execute("insertText", inserted);
        }
        while (editor.execute("undo")) {
          // keep undoing
        }
        expect(editor.getText()).toBe(text);
      }),
    );
  });
});
