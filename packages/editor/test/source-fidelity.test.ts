// Source fidelity properties, checked through the editor core's public interface:
// text the user did not edit must survive byte for byte.
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditor, type EditorMode, type MintEditor } from "../src/index.ts";

const editors: MintEditor[] = [];
let mode: EditorMode = "livePreview";
function closeAll() {
  for (const editor of editors.splice(0)) editor.destroy();
}
/** Open a file in a fresh editor; each property run needs only one, so earlier ones are closed. */
function open(text: string): MintEditor {
  closeAll();
  const editor = createEditor({ parent: document.body, text, mode });
  editors.push(editor);
  return editor;
}
afterEach(closeAll);

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
    "**bold** and *it*",
    "~~del~~ `code` [link](x.md)",
    "<https://a.example> https://b.example",
    "[ref][r] ***x*** _y_",
    "[r]: https://r.example",
    "  ",
    "",
  ),
  fc.string({
    unit: fc.constantFrom(..."*_`#-| a中\t😀[]()~<>"),
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

describe.each<EditorMode>(["livePreview", "source"])("source fidelity in %s mode", (m) => {
  beforeEach(() => {
    mode = m;
  });

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

  it("rendering never changes the text, wherever the selection goes and whatever the mode", () => {
    const moves = fc.array(
      fc.record({
        a: fc.double({ min: 0, max: 1, noNaN: true }),
        b: fc.double({ min: 0, max: 1, noNaN: true }),
        toggle: fc.boolean(),
      }),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(fileText, moves, (text, steps) => {
        const editor = open(text);
        for (const { a, b, toggle } of steps) {
          editor.setSelection({
            anchor: Math.round(a * text.length),
            head: Math.round(b * text.length),
          });
          const selection = editor.getSelection();
          if (toggle) editor.execute("toggleSourceMode");
          expect(editor.getSelection()).toEqual(selection);
          expect(editor.getText()).toBe(text);
        }
      }),
    );
  });

  it("reloading takes the file from disk exactly, and undo brings the old text back", () => {
    fc.assert(
      fc.property(fileText, fileText, edit, (text, reloaded, { a, b, text: inserted }) => {
        const editor = open(text);
        const length = text.length;
        editor.setSelection({ anchor: Math.round(a * length), head: Math.round(b * length) });
        editor.execute("insertText", inserted);
        const edited = editor.getText();

        editor.replaceText(reloaded);
        expect(editor.getText()).toBe(reloaded);

        editor.execute("undo");
        expect(editor.getText()).toBe(edited);
        editor.execute("redo");
        expect(editor.getText()).toBe(reloaded);
      }),
    );
  });
});
