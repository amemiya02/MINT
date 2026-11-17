// Seam 1: the editor core's public interface.
// Create an editor from text, drive it with commands, assert on text / selection / events.
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

describe("editor core", () => {
  it("returns the document text exactly as it was opened", () => {
    expect(open("# Title\n\nBody\n").getText()).toBe("# Title\n\nBody\n");
  });

  it("inserts typed text at the selection", () => {
    const editor = open("Hello world");
    editor.setSelection({ anchor: 6, head: 11 });
    editor.execute("insertText", "MINT");
    expect(editor.getText()).toBe("Hello MINT");
    expect(editor.getSelection()).toEqual({ anchor: 10, head: 10 });
  });

  it("notifies subscribers when the text changes", () => {
    const editor = open("a");
    const events: string[] = [];
    editor.subscribe((event) => events.push(event.type));
    editor.setSelection({ anchor: 1 });
    editor.execute("insertText", "b");
    expect(events).toContain("change");
  });

  it("stops notifying after unsubscribe", () => {
    const editor = open("a");
    let calls = 0;
    const unsubscribe = editor.subscribe(() => calls++);
    unsubscribe();
    editor.execute("insertText", "b");
    expect(calls).toBe(0);
  });

  it("undoes and redoes edits", () => {
    const editor = open("one");
    editor.setSelection({ anchor: 3 });
    editor.execute("insertText", " two");
    expect(editor.execute("undo")).toBe(true);
    expect(editor.getText()).toBe("one");
    expect(editor.execute("redo")).toBe(true);
    expect(editor.getText()).toBe("one two");
  });

  it("keeps CRLF line endings and uses them for new line breaks", () => {
    const editor = open("a\r\nb\r\n");
    editor.setSelection({ anchor: 4 }); // after "b"
    editor.execute("insertText", "\nc");
    expect(editor.getText()).toBe("a\r\nb\r\nc\r\n");
  });

  it("keeps a UTF-8 byte order mark outside the editable text", () => {
    const editor = open("﻿# Title\n");
    editor.setSelection({ anchor: 0 });
    editor.execute("insertText", "x");
    expect(editor.getText()).toBe("﻿x# Title\n");
  });

  it("reports selection offsets in the coordinates of getText()", () => {
    const editor = open("﻿ab\r\ncd");
    editor.setSelection({ anchor: 6 }); // between "c" and "d"
    editor.execute("insertText", "X");
    expect(editor.getText()).toBe("﻿ab\r\ncXd");
    expect(editor.getSelection()).toEqual({ anchor: 7, head: 7 });
  });

  it("preserves mixed line endings that the user did not touch", () => {
    const editor = open("a\nb\r\nc\rd");
    editor.setSelection({ anchor: 0 });
    editor.execute("insertText", "> ");
    expect(editor.getText()).toBe("> a\nb\r\nc\rd");
  });
});

describe("replacing the text (reload from disk)", () => {
  it("takes the new text and keeps the cursor next to the text around it", () => {
    const editor = open("one\ntwo\nthree\n");
    editor.setSelection({ anchor: 10 }); // "th|ree"
    editor.replaceText("zero\none\ntwo\nthree\n");
    expect(editor.getText()).toBe("zero\none\ntwo\nthree\n");
    expect(editor.getSelection()).toEqual({ anchor: 15, head: 15 });
  });
});
