// The front matter block widget through the editor core's public interface:
// what the user sees (rendered lines and the folded metadata block) as the
// selection moves, and the text that edits produce.
import { defaultDialect, renderHtml } from "@mint/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, type EditorOptions, type MintEditor } from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  /** The editable lines as displayed: a folded block shows none of its lines. */
  const shown = () =>
    [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
  /** The folded front matter block, if one is displayed. */
  const folded = () => parent.querySelector<HTMLElement>(".cm-mint-front-matter");
  const toEnd = () => editor.setSelection({ anchor: editor.getText().length });
  return { editor, parent, shown, folded, toEnd };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

function press(element: Element) {
  element.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
  );
}

const post = "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body";

describe("front matter", () => {
  it("is displayed as a folded metadata block naming its fields", () => {
    const { shown, folded, toEnd } = open(post);
    toEnd();
    expect(shown()).toBe("\n# Body");
    expect(folded()?.textContent).toContain("title, tags");
  });

  it("stays folded when the document opens with the cursor at its start", () => {
    const { shown, folded } = open(post);
    expect(folded()).not.toBeNull();
    expect(shown()).toBe("\nBody");
  });

  it("unfolds to its source when pressed, with the cursor on its first field", () => {
    const { editor, shown, folded, toEnd } = open(post);
    toEnd();
    press(folded() as HTMLElement);
    expect(folded()).toBeNull();
    expect(editor.getSelection()).toEqual({ anchor: 4, head: 4 });
    expect(shown()).toBe("---▾\ntitle: Hello\ntags: [a, b]\n---\n\nBody");
  });

  it("unfolds when the cursor enters it and folds again when the cursor leaves", () => {
    const { editor, shown, folded, toEnd } = open(post);
    editor.setSelection({ anchor: 30 }); // on the closing fence, as after moving up into it
    expect(folded()).toBeNull();
    toEnd();
    expect(folded()).not.toBeNull();
    expect(shown()).toBe("\n# Body");
  });

  it("folds with the fold control on its opening fence, moving the cursor below it", () => {
    const { editor, parent, folded } = open(post);
    editor.setSelection({ anchor: 10 });
    press(parent.querySelector(".cm-mint-front-matter-fold") as HTMLElement);
    expect(folded()).not.toBeNull();
    expect(editor.getSelection()).toEqual({ anchor: 34, head: 34 });
  });

  it("changes only the text inside the block when edited", () => {
    const { editor, folded, toEnd } = open(post);
    toEnd();
    press(folded() as HTMLElement);
    editor.setSelection({ anchor: 16 }); // after "title: Hello"
    editor.execute("insertText", ", world\ndate: 2026-11-17");
    expect(editor.getText()).toBe(
      "---\ntitle: Hello, world\ndate: 2026-11-17\ntags: [a, b]\n---\n\n# Body",
    );
    toEnd();
    expect(folded()?.textContent).toContain("title, date, tags");
  });

  it("is shown as raw text in source mode", () => {
    const { shown, folded, toEnd } = open(post, { mode: "source" });
    toEnd();
    expect(folded()).toBeNull();
    expect(shown()).toBe(post);
  });

  it("becomes a block once its closing fence is typed, and stops being one when it is broken", () => {
    const { editor, folded, toEnd } = open("---\ntitle: Hello\n\n# Body");
    toEnd();
    expect(folded()).toBeNull();
    editor.setSelection({ anchor: 16 });
    editor.execute("insertText", "\n---");
    toEnd();
    expect(folded()?.textContent).toContain("title");
    editor.setSelection({ anchor: 0, head: 1 });
    editor.execute("insertText", "");
    toEnd();
    expect(folded()).toBeNull();
  });
});

describe("front matter dialect", () => {
  // The same samples through the editor (folded block or not) and the export
  // pipeline (metadata left out of the HTML or not): both must agree.
  const samples: [name: string, text: string, isFrontMatter: boolean][] = [
    ["a block at the start", "---\ntitle: T\n---\nbody", true],
    ["an empty block", "---\n---\nbody", true],
    ["fences with trailing spaces", "--- \ntitle: T\n---\t\nbody", true],
    ["a block ending the document", "---\ntitle: T\n---", true],
    ["a block after a blank line", "\n---\ntitle: T\n---\nbody", false],
    ["a block after text", "intro\n\n---\ntitle: T\n---\nbody", false],
    ["an unclosed block", "---\ntitle: T\n\nbody", false],
    ["an indented fence", " ---\ntitle: T\n---\nbody", false],
    ["a longer fence", "----\ntitle: T\n----\nbody", false],
  ];

  it.each(samples)("editor and export agree on %s", (_, text, isFrontMatter) => {
    const { folded } = open(text); // the cursor at the start leaves a block folded
    expect(folded() !== null).toBe(isFrontMatter);
    expect(renderHtml(text, defaultDialect).includes("title")).toBe(!isFrontMatter);
  });

  it("is not recognised when the dialect disables front matter", () => {
    const dialect = { ...defaultDialect, frontMatter: false };
    const { folded, toEnd } = open(post, { dialect });
    toEnd();
    expect(folded()).toBeNull();
    expect(renderHtml(post, dialect)).toContain("<h2>title: Hello");
  });
});
