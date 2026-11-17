// Live preview of block structure through the editor core's public interface:
// headings, lists, task lists, block quotes, horizontal rules, footnotes, code
// blocks, and the outline.
import { defaultDialect } from "@mint/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, type EditorOptions, type MintEditor } from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  const lines = () => [...parent.querySelectorAll<HTMLElement>(".cm-line")];
  /** The text as displayed: hidden markers are absent, widgets show their text. */
  const shown = () =>
    lines()
      .map((line) => line.textContent)
      .join("\n");
  return { editor, parent, shown, lines };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

describe("headings", () => {
  it("shows a line as a level-2 heading as soon as `## ` is typed", async () => {
    const { editor, shown, lines } = open("Title\n\nend");
    editor.setSelection({ anchor: 0 });
    editor.execute("insertText", "## ");
    expect(editor.getText()).toBe("## Title\n\nend");
    await expect.poll(() => lines()[0]?.getAttribute("aria-level")).toBe("2");
    await expect.poll(() => lines()[0]?.getAttribute("role")).toBe("heading");
    // The cursor touches the heading, so its marker is revealed, like a span.
    await expect.poll(shown).toBe("## Title\n\nend");
    editor.setSelection({ anchor: editor.getText().length });
    await expect.poll(shown).toBe("Title\n\nend");
  });

  it("reveals heading markers the same way as inline spans: only when the selection touches the heading", async () => {
    const { editor, shown } = open("# One #\n\n###### Six\n\nend");
    editor.setSelection({ anchor: editor.getText().length });
    await expect.poll(shown).toBe("One\n\nSix\n\nend");
    editor.setSelection({ anchor: 3 });
    await expect.poll(shown).toBe("# One #\n\nSix\n\nend");
  });

  it("renders setext headings and hides their underline", async () => {
    const { editor, shown, lines } = open("Big\n===\n\nend");
    editor.setSelection({ anchor: editor.getText().length });
    await expect.poll(() => lines()[0]?.getAttribute("aria-level")).toBe("1");
    await expect.poll(shown).toBe("Big\n\n\nend");
  });
});

/** Press a key in the editor the way a user would. */
function press(parent: HTMLElement, key: string) {
  const content = parent.querySelector(".cm-content");
  if (!content) throw new Error("editor not mounted");
  content.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("continuing lists and quotes on Enter", () => {
  it.each([
    ["a bullet list", "- one", "- one\n- "],
    ["an ordered list", "1. one", "1. one\n2. "],
    ["a task list", "- [x] one", "- [x] one\n- [ ] "],
    ["a block quote", "> one", "> one\n> "],
  ])("continues %s", async (_, text, expected) => {
    const { editor, parent } = open(text);
    editor.setSelection({ anchor: text.length });
    press(parent, "Enter");
    expect(editor.getText()).toBe(expected);
    expect(editor.getSelection().head).toBe(expected.length);
  });

  it("ends the list when Enter is pressed on an empty item", async () => {
    const { editor, parent } = open("- one\n- ");
    editor.setSelection({ anchor: 8 });
    press(parent, "Enter");
    expect(editor.getText()).toBe("- one\n");
    press(parent, "Enter");
    expect(editor.getText()).toBe("- one\n\n");
  });

  it("keeps CRLF line endings when continuing a list", async () => {
    const { editor, parent } = open("- one\r\n");
    editor.setSelection({ anchor: 5 });
    press(parent, "Enter");
    expect(editor.getText()).toBe("- one\r\n- \r\n");
  });
});

describe("lists", () => {
  it("renders bullet markers as bullets and keeps ordered numbers", async () => {
    const { editor, shown } = open("- one\n* two\n\n1. first\n2) second\n\nend");
    editor.setSelection({ anchor: editor.getText().length });
    await expect.poll(shown).toBe("• one\n• two\n\n1. first\n2) second\n\nend");
  });

  it("reveals a bullet marker when the cursor touches it", async () => {
    const { editor, shown } = open("- one\n- two");
    editor.setSelection({ anchor: 1 });
    await expect.poll(shown).toBe("- one\n• two");
  });
});

describe("task lists", () => {
  function checkboxes(parent: HTMLElement) {
    return [...parent.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
  }
  function click(element: Element) {
    for (const type of ["mousedown", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    }
  }

  it("renders task markers as checkboxes", async () => {
    const { editor, parent, shown } = open("- [ ] todo\n- [x] done\n\nend");
    editor.setSelection({ anchor: editor.getText().length });
    await expect.poll(() => checkboxes(parent).map((box) => box.checked)).toEqual([false, true]);
    await expect.poll(shown).toBe(" todo\n done\n\nend");
  });

  it("toggles `[ ]` and `[x]` on click, changing only that one character", async () => {
    const text = "- [ ] todo\n- [X] done\n\nend";
    const { editor, parent } = open(text);
    editor.setSelection({ anchor: text.length });
    const changes: string[] = [];
    editor.subscribe((event) => {
      if (event.type === "change") changes.push(editor.getText());
    });

    await expect.poll(() => checkboxes(parent)).toHaveLength(2);
    click(checkboxes(parent)[0] as HTMLInputElement);
    expect(editor.getText()).toBe("- [x] todo\n- [X] done\n\nend");
    await expect.poll(() => checkboxes(parent)[0]?.checked).toBe(true);
    click(checkboxes(parent)[1] as HTMLInputElement);
    expect(editor.getText()).toBe("- [x] todo\n- [ ] done\n\nend");
    await expect.poll(() => checkboxes(parent).map((box) => box.checked)).toEqual([true, false]);
    expect(changes).toHaveLength(2);
    // The cursor stays where it was.
    expect(editor.getSelection()).toEqual({ anchor: text.length, head: text.length });

    editor.execute("undo");
    expect(editor.getText()).toBe("- [x] todo\n- [X] done\n\nend");
  });

  it("reveals the task marker when the cursor touches it", async () => {
    const { editor, parent, shown } = open("- [ ] todo\n- [ ] next");
    editor.setSelection({ anchor: 4 });
    await expect.poll(shown).toBe("- [ ] todo\n next");
    await expect.poll(() => checkboxes(parent)).toHaveLength(1);
  });
});

describe("block quotes and horizontal rules", () => {
  it("renders block quotes with their markers hidden", async () => {
    const { editor, shown, lines } = open("> one\n> two\n>> deep\n\nend");
    editor.setSelection({ anchor: editor.getText().length });
    await expect.poll(shown).toBe("one\ntwo\ndeep\n\nend");
    await expect
      .poll(() => lines().map((line) => line.classList.contains("cm-mint-blockquote")))
      .toEqual([true, true, true, false, false]);
  });

  it("reveals a quote marker when the cursor touches it", async () => {
    const { editor, shown } = open("> one\n> two");
    editor.setSelection({ anchor: 7 });
    await expect.poll(shown).toBe("one\n> two");
  });

  it("renders a horizontal rule as a rule and reveals it when the cursor is on it", async () => {
    const { editor, shown, lines } = open("a\n\n***\n\nb");
    editor.setSelection({ anchor: editor.getText().length });
    await expect.poll(shown).toBe("a\n\n\n\nb");
    await expect.poll(() => lines()[2]?.querySelector("hr")).not.toBeNull();
    editor.setSelection({ anchor: 4 });
    await expect.poll(shown).toBe("a\n\n***\n\nb");
  });
});

describe("code blocks", () => {
  const text = "```js\nconst x = 1;\n```\n\nend";

  it("shows a language label instead of the fences while the cursor is outside the block", async () => {
    const { editor, parent, shown } = open(text);
    editor.setSelection({ anchor: text.length });
    await expect.poll(shown).toBe("js\nconst x = 1;\n\n\nend");
    await expect.poll(() => parent.querySelector("[class*=language]")?.textContent).toBe("js");
  });

  it("shows the fences when the cursor enters the block", async () => {
    const { editor, shown } = open(text);
    editor.setSelection({ anchor: 8 });
    await expect.poll(shown).toBe(text);
  });

  it("highlights the code according to its language", async () => {
    const { editor, lines } = open(text);
    editor.setSelection({ anchor: text.length });
    await vi.waitFor(() => {
      const keyword = [...(lines()[1]?.querySelectorAll("span") ?? [])].find(
        (span) => span.textContent === "const",
      );
      expect(keyword?.className).toBeTruthy();
    });
  });

  it("changes the language of the block at the cursor, touching only the info string", async () => {
    const { editor, shown } = open(`${text}\n\n~~~\nplain\n~~~\n`);
    editor.setSelection({ anchor: 8 });
    expect(editor.execute("setCodeBlockLanguage", "typescript")).toBe(true);
    expect(editor.getText()).toBe("```typescript\nconst x = 1;\n```\n\nend\n\n~~~\nplain\n~~~\n");

    editor.setSelection({ anchor: 39 }); // inside "plain"
    expect(editor.execute("setCodeBlockLanguage", "text")).toBe(true);
    expect(editor.getText()).toBe(
      "```typescript\nconst x = 1;\n```\n\nend\n\n~~~text\nplain\n~~~\n",
    );

    editor.setSelection({ anchor: 33 }); // in "end", outside any code block
    expect(editor.execute("setCodeBlockLanguage", "rust")).toBe(false);
    await expect.poll(shown).toBe("typescript\nconst x = 1;\n\n\nend\n\ntext\nplain\n\n");
  });

  it("selects the language for editing when its label is clicked", async () => {
    const { editor, parent } = open(text);
    editor.setSelection({ anchor: text.length });
    await expect.poll(() => parent.querySelector("[class*=language]")).not.toBeNull();
    const label = parent.querySelector("[class*=language]");
    label?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(editor.getSelection()).toEqual({ anchor: 3, head: 5 });
  });
});

describe("outline", () => {
  it("lists the headings with their levels, text and positions", () => {
    const text =
      "# Intro #\n\nbody\n\nSetext\n---\n\n```\n# not a heading\n```\n\n- ### In a list\n\n#### **Bold** `code` [link](x.md)\n";
    const { editor } = open(text);
    expect(editor.getOutline()).toEqual([
      { level: 1, text: "Intro", from: 0 },
      { level: 2, text: "Setext", from: 17 },
      { level: 3, text: "In a list", from: 56 },
      { level: 4, text: "Bold code link", from: 71 },
    ]);
  });

  it("reports positions in getText() offsets", () => {
    const { editor } = open("﻿a\r\n\r\n## Two\r\n");
    expect(editor.getOutline()).toEqual([{ level: 2, text: "Two", from: 6 }]);
  });

  it("notifies subscribers when the outline changes, and only then", () => {
    const { editor } = open("# One\n\nbody\n");
    const events: string[] = [];
    editor.subscribe((event) => events.push(event.type));
    const outlineEvents = () => events.filter((type) => type === "outline").length;

    editor.setSelection({ anchor: 11 });
    editor.execute("insertText", "x"); // body text: no outline change
    expect(outlineEvents()).toBe(0);

    editor.setSelection({ anchor: 5 });
    editor.execute("insertText", "!"); // heading text
    expect(outlineEvents()).toBe(1);
    expect(editor.getOutline()).toEqual([{ level: 1, text: "One!", from: 0 }]);

    editor.setSelection({ anchor: 8 });
    editor.execute("insertText", "## "); // a new heading
    expect(outlineEvents()).toBe(2);
    expect(editor.getOutline().map((heading) => heading.text)).toEqual(["One!", "bodyx"]);
  });

  it("notifies subscribers when the editor scrolls, and reports the visible range", () => {
    const text = "# One\n\nbody\n\n## Two\n";
    const { editor, parent } = open(text);
    const events: string[] = [];
    editor.subscribe((event) => events.push(event.type));
    parent.querySelector(".cm-scroller")?.dispatchEvent(new Event("scroll"));
    expect(events).toContain("scroll");

    const { from, to } = editor.getVisibleRange();
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThanOrEqual(from);
    expect(to).toBeLessThanOrEqual(text.length);
  });

  it("jumps to a heading, scrolling it to the top, in getText() offsets", () => {
    const { editor } = open("\uFEFFa\r\n\r\n## Two\r\n");
    const [two] = editor.getOutline();
    editor.setSelection({ anchor: two?.from ?? -1, scrollIntoView: "start" });
    expect(editor.getSelection()).toEqual({ anchor: 6, head: 6 });
  });
});

describe("footnotes", () => {
  const text = "Claim[^note] here.\n\n[^note]: A **strong** source.\n\nend";

  it("renders footnote references and definitions with their markers hidden", async () => {
    const { editor, parent, shown } = open(text);
    editor.setSelection({ anchor: text.length });
    await expect.poll(shown).toBe("Claimnote here.\n\nnote: A strong source.\n\nend");
    const labels = () =>
      [...parent.querySelectorAll("[class*=footnote]")].map((el) => el.textContent);
    expect(labels()).toEqual(["note", "note"]);
  });

  it("reveals a footnote reference's markers when the cursor touches it", async () => {
    const { editor, shown } = open(text);
    editor.setSelection({ anchor: 7 });
    await expect.poll(shown).toBe("Claim[^note] here.\n\nnote: A strong source.\n\nend");
  });

  it("reveals a footnote definition's label when the cursor is on its line", async () => {
    const { editor, shown } = open(text);
    editor.setSelection({ anchor: 21 });
    await expect.poll(shown).toBe("Claimnote here.\n\n[^note]: A strong source.\n\nend");
  });

  it("has no footnotes when GFM is off: CommonMark reads them as a reference link", async () => {
    const { editor, parent, shown } = open("a[^1]\n\n[^1]: b\n\nend", {
      dialect: { ...defaultDialect, gfm: false },
    });
    editor.setSelection({ anchor: 17 });
    await expect.poll(shown).toBe("a^1\n\n[^1]: b\n\nend");
    await expect.poll(() => parent.querySelector("[class*=footnote]")).toBeNull();
  });
});
