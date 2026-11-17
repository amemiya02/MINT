// Find and replace within a document, through the editor core's public interface.
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

describe("find", () => {
  it("selects the next match after the cursor", () => {
    const editor = open("cat dog cat dog");
    editor.setSelection({ anchor: 1 });
    editor.execute("setFindQuery", { search: "dog" });
    expect(editor.execute("findNext")).toBe(true);
    expect(editor.getSelection()).toEqual({ anchor: 4, head: 7 });
    expect(editor.execute("findNext")).toBe(true);
    expect(editor.getSelection()).toEqual({ anchor: 12, head: 15 });
  });

  it("wraps around the end and the start of the document", () => {
    const editor = open("dog cat dog");
    editor.setSelection({ anchor: 9 });
    editor.execute("setFindQuery", { search: "dog" });
    editor.execute("findNext");
    expect(editor.getSelection()).toEqual({ anchor: 0, head: 3 });
    editor.execute("findPrevious");
    expect(editor.getSelection()).toEqual({ anchor: 8, head: 11 });
    editor.execute("findPrevious");
    expect(editor.getSelection()).toEqual({ anchor: 0, head: 3 });
  });

  it("reports how many matches there are and which one is selected", () => {
    const editor = open("a dog, a Dog, a DOG");
    editor.setSelection({ anchor: 0 });
    editor.execute("setFindQuery", { search: "dog" });
    expect(editor.getFindStatus()).toEqual({ total: 3, current: 0, valid: true });
    editor.execute("findNext");
    editor.execute("findNext");
    expect(editor.getFindStatus()).toEqual({ total: 3, current: 2, valid: true });
  });

  it("can match case exactly", () => {
    const editor = open("Dog dog DOG");
    editor.execute("setFindQuery", { search: "dog", caseSensitive: true });
    expect(editor.getFindStatus().total).toBe(1);
    editor.execute("findNext");
    expect(editor.getSelection()).toEqual({ anchor: 4, head: 7 });
  });

  it("can match whole words only", () => {
    const editor = open("cat concat cats cat");
    editor.execute("setFindQuery", { search: "cat", wholeWord: true });
    expect(editor.getFindStatus().total).toBe(2);
  });

  it("searches with a regular expression", () => {
    const editor = open("v1.2 and v10.0");
    editor.execute("setFindQuery", { search: "v\\d+\\.\\d", regexp: true });
    expect(editor.getFindStatus().total).toBe(2);
    editor.execute("findNext");
    expect(editor.getSelection()).toEqual({ anchor: 0, head: 4 });
  });

  it("treats an invalid regular expression as no query instead of failing", () => {
    const editor = open("text");
    editor.execute("setFindQuery", { search: "(", regexp: true });
    expect(editor.getFindStatus()).toEqual({ total: 0, current: 0, valid: false });
    expect(editor.execute("findNext")).toBe(false);
  });

  it("searches the source, so a match inside markers live preview hides is found and selected", () => {
    const editor = open("Some **bold** and [a link](https://example.com).");
    editor.execute("setFindQuery", { search: "**" });
    editor.execute("findNext");
    expect(editor.getSelection()).toEqual({ anchor: 5, head: 7 });
    editor.execute("setFindQuery", { search: "example" });
    editor.execute("findNext");
    expect(editor.getSelection()).toEqual({ anchor: 35, head: 42 });
  });

  it("reports match positions in file offsets, across CRLF line breaks and a BOM", () => {
    const editor = open("\uFEFFone\r\ntwo\r\nthree\r\n");
    editor.execute("setFindQuery", { search: "three" });
    editor.execute("findNext");
    expect(editor.getSelection()).toEqual({ anchor: 11, head: 16 });
  });

  it("stops finding once the query is cleared", () => {
    const editor = open("dog");
    editor.execute("setFindQuery", { search: "dog" });
    editor.execute("setFindQuery", null);
    expect(editor.execute("findNext")).toBe(false);
    expect(editor.getFindStatus().valid).toBe(false);
  });
});

describe("replace", () => {
  it("replaces the selected match and moves to the next", () => {
    const editor = open("cat dog cat");
    editor.setSelection({ anchor: 0 });
    editor.execute("setFindQuery", { search: "cat", replace: "cow" });
    editor.execute("findNext");
    expect(editor.execute("replaceNext")).toBe(true);
    expect(editor.getText()).toBe("cow dog cat");
    expect(editor.getSelection()).toEqual({ anchor: 8, head: 11 });
  });

  it("only selects the next match when no match is selected yet", () => {
    const editor = open("cat dog cat");
    editor.setSelection({ anchor: 2 });
    editor.execute("setFindQuery", { search: "cat", replace: "cow" });
    editor.execute("replaceNext");
    expect(editor.getText()).toBe("cat dog cat");
    expect(editor.getSelection()).toEqual({ anchor: 8, head: 11 });
  });

  it("replaces all matches, and one undo restores the original", () => {
    const original = "cat dog\r\ncat Cat\r\nconcat\r\n";
    const editor = open(original);
    editor.execute("setFindQuery", { search: "cat", replace: "cow", wholeWord: true });
    expect(editor.execute("replaceAll")).toBe(true);
    expect(editor.getText()).toBe("cow dog\r\ncow cow\r\nconcat\r\n");
    expect(editor.execute("undo")).toBe(true);
    expect(editor.getText()).toBe(original);
    expect(editor.execute("redo")).toBe(true);
    expect(editor.getText()).toBe("cow dog\r\ncow cow\r\nconcat\r\n");
  });

  it("expands capture groups in a regular-expression replacement", () => {
    const editor = open("2026-11-17 and 1999-01-02");
    editor.execute("setFindQuery", {
      search: "(\\d{4})-(\\d{2})-(\\d{2})",
      replace: "$3/$2/$1 ($&, $$)",
      regexp: true,
    });
    editor.execute("replaceAll");
    expect(editor.getText()).toBe("17/11/2026 (2026-11-17, $) and 02/01/1999 (1999-01-02, $)");
  });

  it("inserts a plain replacement literally, even if it looks like a group reference", () => {
    const editor = open("price");
    editor.execute("setFindQuery", { search: "price", replace: "$1" });
    editor.execute("replaceAll");
    expect(editor.getText()).toBe("$1");
  });

  it("does nothing when there is no match", () => {
    const editor = open("text");
    editor.execute("setFindQuery", { search: "zzz", replace: "y" });
    expect(editor.execute("replaceAll")).toBe(false);
    expect(editor.getText()).toBe("text");
  });

  it("leaves text outside the matches byte for byte unchanged", () => {
    const original = "* a\r\n- **a**\n\n| a |\r";
    const editor = open(original);
    editor.execute("setFindQuery", { search: "a", replace: "b", caseSensitive: true });
    editor.execute("replaceAll");
    expect(editor.getText()).toBe("* b\r\n- **b**\n\n| b |\r");
  });
});
