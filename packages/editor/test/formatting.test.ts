// Seam 1: the editor core's public interface.
// Formatting commands (the ones bound to Typora's default shortcuts) change only
// the text they format, and leave the selection on the formatted text.
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, type MintEditor } from "../src/index.ts";

const editors: MintEditor[] = [];
/** Open `text`; a `|` marks the cursor, two `|` mark a selection. */
function open(marked: string): MintEditor {
  const [a, b] = [marked.indexOf("|"), marked.lastIndexOf("|")];
  const text = marked.replaceAll("|", "");
  const editor = createEditor({ parent: document.body, text });
  editors.push(editor);
  if (a >= 0) editor.setSelection({ anchor: a, head: a === b ? a : b - 1 });
  return editor;
}
/** The text with the selection marked as in {@link open}. */
function marked(editor: MintEditor): string {
  const text = editor.getText();
  const { anchor, head } = editor.getSelection();
  const [from, to] = [Math.min(anchor, head), Math.max(anchor, head)];
  if (from === to) return `${text.slice(0, from)}|${text.slice(from)}`;
  return `${text.slice(0, from)}|${text.slice(from, to)}|${text.slice(to)}`;
}
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("setHeading", () => {
  it("turns a paragraph into a heading of the given level", () => {
    const editor = open("Intro\n\nTi|tle\n");
    expect(editor.execute("setHeading", 2)).toBe(true);
    expect(marked(editor)).toBe("Intro\n\n## Ti|tle\n");
  });

  it("changes the level of a heading, touching only its marker", () => {
    const editor = open("### Ti|tle ###\n");
    editor.execute("setHeading", 1);
    expect(marked(editor)).toBe("# Ti|tle ###\n");
  });

  it("toggles a heading of the same level back to a paragraph", () => {
    const editor = open("## Ti|tle\n");
    editor.execute("setHeading", 2);
    expect(marked(editor)).toBe("Ti|tle\n");
  });

  it("puts the cursor after the new marker on an empty line", () => {
    const editor = open("a\n\n|\n");
    editor.execute("setHeading", 3);
    expect(marked(editor)).toBe("a\n\n### |\n");
  });

  it("formats every line of the selection", () => {
    const editor = open("|one\ntwo|\n");
    editor.execute("setHeading", 4);
    expect(editor.getText()).toBe("#### one\n#### two\n");
  });

  it("keeps block quote and list markers", () => {
    const editor = open("> quo|ted\n\n- item\n");
    editor.execute("setHeading", 2);
    expect(editor.getText()).toBe("> ## quoted\n\n- item\n");
    editor.setSelection({ anchor: editor.getText().indexOf("item") });
    editor.execute("setHeading", 2);
    expect(editor.getText()).toBe("> ## quoted\n\n- ## item\n");
  });

  it("leaves code blocks alone", () => {
    const editor = open("```\nco|de\n```\n");
    expect(editor.execute("setHeading", 1)).toBe(false);
    expect(editor.getText()).toBe("```\ncode\n```\n");
  });

  it("changes setext headings to ATX headings", () => {
    const editor = open("Ti|tle\n=====\n\nnext\n");
    editor.execute("setHeading", 2);
    expect(editor.getText()).toBe("## Title\n\nnext\n");
  });

  it("keeps CRLF line endings around the edit", () => {
    const editor = open("a\r\nb|\r\n");
    editor.execute("setHeading", 1);
    expect(editor.getText()).toBe("a\r\n# b\r\n");
  });

  it("is undone in one step", () => {
    const editor = open("|one\ntwo|\n");
    editor.execute("setHeading", 1);
    editor.execute("undo");
    expect(editor.getText()).toBe("one\ntwo\n");
  });
});

describe("setParagraph", () => {
  it("removes the heading marker and closing sequence", () => {
    const editor = open("## Ti|tle ##\n");
    editor.execute("setParagraph");
    expect(marked(editor)).toBe("Ti|tle\n");
  });

  it("removes a setext underline", () => {
    const editor = open("Ti|tle\n---\n");
    editor.execute("setParagraph");
    expect(marked(editor)).toBe("Ti|tle\n");
  });

  it("does nothing on a paragraph", () => {
    const editor = open("plain| text\n");
    expect(editor.execute("setParagraph")).toBe(false);
    expect(editor.getText()).toBe("plain text\n");
  });
});

describe("toggleBold and toggleItalic", () => {
  it("wraps the selection and keeps it on the text", () => {
    const editor = open("a |word| b\n");
    editor.execute("toggleBold");
    expect(marked(editor)).toBe("a **|word|** b\n");
  });

  it("removes the strong emphasis around the cursor", () => {
    const editor = open("a **wo|rd** b\n");
    editor.execute("toggleBold");
    expect(marked(editor)).toBe("a wo|rd b\n");
  });

  it("inserts an empty pair at a cursor and removes it again", () => {
    const editor = open("a |\n");
    editor.execute("toggleBold");
    expect(marked(editor)).toBe("a **|**\n");
    editor.execute("toggleBold");
    expect(marked(editor)).toBe("a |\n");
  });

  it("italicises with a single asterisk and removes either emphasis mark", () => {
    const editor = open("|word|\n");
    editor.execute("toggleItalic");
    expect(marked(editor)).toBe("*|word|*\n");
    const underscored = open("_wo|rd_\n");
    underscored.execute("toggleItalic");
    expect(marked(underscored)).toBe("wo|rd\n");
  });
});

describe("toggleLink", () => {
  it("makes the selection a link's text and puts the cursor at the URL", () => {
    const editor = open("see |MINT| now\n");
    editor.execute("toggleLink");
    expect(marked(editor)).toBe("see [MINT](|) now\n");
  });

  it("inserts empty brackets at a cursor", () => {
    const editor = open("see |\n");
    editor.execute("toggleLink");
    expect(marked(editor)).toBe("see [|]()\n");
  });

  it("removes a link and keeps its text", () => {
    const editor = open("see [MI|NT](https://example.com) now\n");
    editor.execute("toggleLink");
    expect(marked(editor)).toBe("see MI|NT now\n");
  });
});

describe("insertCodeBlock", () => {
  it("inserts an empty fenced code block on an empty line", () => {
    const editor = open("a\n\n|\n");
    editor.execute("insertCodeBlock");
    expect(marked(editor)).toBe("a\n\n```\n|\n```\n");
  });

  it("fences the selected lines", () => {
    const editor = open("|one\ntwo|\n");
    editor.execute("insertCodeBlock");
    expect(editor.getText()).toBe("```\none\ntwo\n```\n");
  });

  it("repeats block quote markers on the new lines", () => {
    const editor = open("> |\n");
    editor.execute("insertCodeBlock");
    expect(marked(editor)).toBe("> ```\n> |\n> ```\n");
  });
});
