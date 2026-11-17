// Writing aids through the editor core's public interface: word count, focus
// mode and typewriter mode.
import { forceParsing } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, type EditorOptions, type MintEditor } from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  // Finish parsing now rather than when a loaded machine gets round to it, so
  // what is rendered never depends on timing.
  const view = EditorView.findFromDOM(parent.querySelector(".cm-editor") as HTMLElement);
  if (view) forceParsing(view, view.state.doc.length, 10_000);
  /** Text of the lines focus mode keeps undimmed. */
  const focused = () =>
    [...parent.querySelectorAll(".cm-line.cm-mint-focused")].map((l) => l.textContent).join("\n");
  const inFocusMode = () => parent.querySelector(".cm-editor.cm-mint-focus-mode") !== null;
  return { editor, parent, focused, inFocusMode };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

describe("word count", () => {
  it("counts words and the characters that are not whitespace", () => {
    expect(open("Hello  world\n").editor.getWordCount()).toMatchObject({
      words: 2,
      characters: 10,
    });
  });

  it("counts each Chinese character as a word in mixed Chinese and English", () => {
    expect(open("中文写作 is fun").editor.getWordCount()).toMatchObject({
      words: 6,
      characters: 9,
    });
    // Punctuation is a character but not a word; Japanese kana count per character too.
    expect(open("你好，MINT 编辑器！かな").editor.getWordCount()).toMatchObject({
      words: 8,
      characters: 13,
    });
  });

  it("keeps contractions, hyphenated words and numbers whole", () => {
    expect(open("don't re-read 3.14 v2").editor.getWordCount().words).toBe(4);
  });

  it("counts the text as rendered, without Markdown markers or link targets", () => {
    const text = "## 标题 Title\n\n- **bold** and [link](https://example.com)\n> `code`\n";
    expect(open(text).editor.getWordCount()).toMatchObject({ words: 7, characters: 22 });
  });

  it("leaves front matter out of the count", () => {
    const text = "---\ntitle: A long title here\n---\n\nBody text\n";
    expect(open(text).editor.getWordCount()).toMatchObject({ words: 2, characters: 8 });
  });

  it("follows edits", () => {
    const { editor } = open("one two");
    editor.setSelection({ anchor: 7 });
    editor.execute("insertText", " three 四");
    expect(editor.getWordCount().words).toBe(4);
  });

  it("estimates the reading time in whole minutes, rounded up", () => {
    expect(open("").editor.getWordCount()).toEqual({ words: 0, characters: 0, readingMinutes: 0 });
    expect(open("word").editor.getWordCount().readingMinutes).toBe(1);
    // 200 English words or 300 Chinese characters a minute.
    expect(open("word ".repeat(400)).editor.getWordCount().readingMinutes).toBe(2);
    expect(open("字".repeat(600)).editor.getWordCount().readingMinutes).toBe(2);
    expect(
      open(`${"word ".repeat(200)}${"字".repeat(300)}`).editor.getWordCount().readingMinutes,
    ).toBe(2);
  });
});

describe("focus mode", () => {
  const text = "First paragraph\nstill first\n\nSecond paragraph\n\n## Heading\n";

  it("is off by default", () => {
    const { editor, focused, inFocusMode } = open(text);
    expect(editor.getSettings()).toMatchObject({ focusMode: false, typewriterMode: false });
    expect(inFocusMode()).toBe(false);
    expect(focused()).toBe("");
  });

  it("keeps only the paragraph with the cursor in focus", () => {
    const { editor, focused, inFocusMode } = open(text, { settings: { focusMode: true } });
    editor.setSelection({ anchor: 3 });
    expect(inFocusMode()).toBe(true);
    expect(focused()).toBe("First paragraph\nstill first");
    editor.setSelection({ anchor: text.indexOf("Second") + 2 });
    expect(focused()).toBe("Second paragraph");
  });

  it("focuses a heading on its own, and only the cursor line between paragraphs", () => {
    const { editor, focused } = open(text, { settings: { focusMode: true } });
    editor.setSelection({ anchor: text.indexOf("Heading") });
    expect(focused()).toBe("## Heading");
    editor.setSelection({ anchor: text.indexOf("\n\nSecond") + 1 });
    expect(focused()).not.toContain("paragraph");
  });

  it("focuses the list item with the cursor rather than the whole list", () => {
    const list = "- one\n- two\n  more two\n- three\n";
    const { editor, focused } = open(list, { settings: { focusMode: true } });
    editor.setSelection({ anchor: list.indexOf("more") });
    expect(focused()).toBe("• two\n  more two"); // the bullet is how live preview shows "-"
  });

  it("is switched on and off through the settings, leaving the text alone", () => {
    const { editor, focused, inFocusMode } = open(text);
    editor.setSelection({ anchor: 3 });
    editor.updateSettings({ focusMode: true });
    expect(editor.getSettings().focusMode).toBe(true);
    expect(inFocusMode()).toBe(true);
    expect(focused()).toBe("First paragraph\nstill first");
    editor.updateSettings({ focusMode: false });
    expect(inFocusMode()).toBe(false);
    expect(focused()).toBe("");
    expect(editor.getText()).toBe(text);
  });
});

// Where the cursor line ends up on screen needs layout, which jsdom lacks; the
// shell's E2E tests check that in a browser.
describe("typewriter mode", () => {
  const isOn = (parent: HTMLElement) =>
    parent.querySelector(".cm-editor.cm-mint-typewriter-mode") !== null;

  it("is switched on from the initial settings or later, independently of focus mode", () => {
    const { editor, parent } = open("text\n", { settings: { typewriterMode: true } });
    expect(isOn(parent)).toBe(true);
    expect(editor.getSettings()).toMatchObject({ focusMode: false, typewriterMode: true });
    editor.updateSettings({ focusMode: true });
    editor.updateSettings({ typewriterMode: false });
    expect(isOn(parent)).toBe(false);
    expect(editor.getSettings()).toMatchObject({ focusMode: true, typewriterMode: false });
  });

  it("leaves typing and the selection as they are", () => {
    const { editor } = open("one\ntwo\n", { settings: { typewriterMode: true } });
    editor.setSelection({ anchor: 7 });
    editor.execute("insertText", "!");
    expect(editor.getText()).toBe("one\ntwo!\n");
    expect(editor.getSelection()).toEqual({ anchor: 8, head: 8 });
  });
});
