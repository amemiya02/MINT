// Themes style the editor through documented class names (docs/themes.md).
// These tests pin that contract: which class marks which piece of Markdown.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, type MintEditor } from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text });
  mounted.push({ editor, parent });
  /** Text of every element carrying `className`, joined. */
  const textWith = (className: string) =>
    [...parent.querySelectorAll(`.${className}`)].map((el) => el.textContent).join("|");
  return { editor, parent, textWith };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

describe("theme classes", () => {
  it("marks each heading level, ATX and setext alike", async () => {
    const { textWith } = open("# One\n\n## Two\n\n###### Six\n\nSetext\n======\n");
    // The first parse may stop early; the rest arrives moments later.
    await vi.waitFor(() => expect(textWith("cm-mint-heading-1")).toContain("Setext"));
    expect(textWith("cm-mint-heading-1")).toContain("One");
    expect(textWith("cm-mint-heading-1")).toContain("Setext");
    expect(textWith("cm-mint-heading-2")).toContain("Two");
    expect(textWith("cm-mint-heading-2")).not.toContain("One");
    expect(textWith("cm-mint-heading-6")).toContain("Six");
    expect(textWith("cm-mint-heading")).toContain("Six");
  });

  it("marks block quotes", () => {
    const { textWith } = open("> quoted\n\nplain");
    expect(textWith("cm-mint-quote")).toContain("quoted");
    expect(textWith("cm-mint-quote")).not.toContain("plain");
  });

  it("does not mark plain paragraphs", () => {
    const { parent } = open("just text");
    expect(parent.querySelector("[class*='cm-mint-heading'], .cm-mint-quote")).toBeNull();
  });
});
