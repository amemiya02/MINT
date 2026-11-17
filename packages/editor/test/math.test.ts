// Math block widgets through the editor core's public interface: what the
// user sees in the mounted editor as the selection moves.
import { defaultDialect, renderHtml } from "@mint/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, type EditorOptions, type MintEditor } from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  /** The TeX source of every formula KaTeX rendered in the editor, in document order. */
  const formulas = () =>
    [...parent.querySelectorAll('annotation[encoding="application/x-tex"]')].map(
      (el) => el.textContent,
    );
  /** The source text still shown as text lines (rendered formulas excluded). */
  const shown = () =>
    [...parent.querySelectorAll(".cm-line")]
      .map((line) => {
        const copy = line.cloneNode(true) as HTMLElement;
        for (const widget of copy.querySelectorAll(".cm-mint-math")) widget.remove();
        return copy.textContent;
      })
      .join("\n");
  const end = () => editor.setSelection({ anchor: editor.getText().length });
  return { editor, parent, formulas, shown, end };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

/**
 * Wait for an assertion to hold. On a loaded machine CodeMirror may finish
 * parsing a document in the background, and math blocks render once it has.
 */
const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 10_000 });

describe("inline math", () => {
  it("renders $…$ with KaTeX while the cursor is elsewhere", async () => {
    const { formulas, shown, end } = open("Euler: $e^{i\\pi}+1=0$ holds.\n\nend");
    end();
    await eventually(() => expect(formulas()).toEqual(["e^{i\\pi}+1=0"]));
    expect(shown()).toBe("Euler:  holds.\n\nend");
  });

  it("shows the source while the cursor touches the formula, and renders it again after", async () => {
    const text = "a $x^2$ b\n\nend";
    const { editor, formulas, shown, end } = open(text);
    end();
    await eventually(() => expect(formulas()).toEqual(["x^2"]));
    editor.setSelection({ anchor: 4 }); // "$x|^2$"
    expect(formulas()).toEqual([]);
    expect(shown()).toBe(text);
    editor.setSelection({ anchor: 7 }); // right after the closing "$"
    expect(shown()).toBe(text);
    end();
    expect(formulas()).toEqual(["x^2"]);
    expect(editor.getText()).toBe(text);
  });

  it("renders a formula that spans lines of a paragraph", async () => {
    const { formulas, shown, end } = open("a $x +\ny$ b\n\nend");
    end();
    await eventually(() => expect(formulas()).toEqual(["x +\ny"]));
    expect(shown()).toBe("a  b\n\nend");
  });

  it("moves the cursor into the source when the formula is clicked", async () => {
    const { editor, parent, shown, end } = open("a $x$ b\n\nend");
    end();
    const widget = await vi.waitUntil(() => parent.querySelector(".cm-mint-math"));
    widget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(editor.getSelection()).toEqual({ anchor: 3, head: 3 });
    expect(shown()).toBe("a $x$ b\n\nend");
  });
});

describe("math blocks", () => {
  const text = "before\n\n$$\n\\sum_{i=1}^n i\n$$\n\nafter";

  it("renders $$…$$ as a display formula in place of its lines", async () => {
    const { parent, formulas, shown, end } = open(text);
    end();
    await eventually(() => expect(formulas()).toEqual(["\\sum_{i=1}^n i"]));
    expect(parent.querySelector(".cm-mint-math .katex-display")).not.toBeNull();
    expect(shown()).toBe("before\n\n\nafter"); // the blank lines around the block stay
  });

  it("expands into its source when the cursor enters any of its lines", async () => {
    const { editor, formulas, shown, end } = open(text);
    end();
    await eventually(() => expect(formulas()).toEqual(["\\sum_{i=1}^n i"]));
    editor.setSelection({ anchor: 8 }); // the opening "$$" line
    expect(formulas()).toEqual([]);
    expect(shown()).toBe(text);
    editor.setSelection({ anchor: 12 }); // inside the TeX
    expect(shown()).toBe(text);
    end();
    expect(formulas()).toEqual(["\\sum_{i=1}^n i"]);
    expect(editor.getText()).toBe(text);
  });

  it("puts the cursor at the start of the TeX when clicked", async () => {
    const { editor, parent, end } = open(text);
    end();
    const widget = await vi.waitUntil(() => parent.querySelector(".cm-mint-math"));
    widget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(editor.getSelection()).toEqual({ anchor: 11, head: 11 });
  });

  it("renders blocks inside block quotes and lists", async () => {
    const { formulas, end } = open("> $$\n> a\n> $$\n\n- $$\n  b\n  $$\n\nend");
    end();
    await eventually(() => expect(formulas()).toEqual(["a", "b"]));
  });

  it("renders a block that is never closed up to the end of the document", async () => {
    const { editor, formulas } = open("text\n\n$$\nc\n\nd");
    editor.setSelection({ anchor: 0 });
    await eventually(() => expect(formulas()).toEqual(["c\n\nd"]));
  });
});

describe("malformed formulas", () => {
  it("shows KaTeX's error message in place of the formula without breaking the editor", async () => {
    const { editor, parent, formulas, end } = open(
      "$\\frac{1}{$ and $y$\n\n$$\n\\left(\n$$\n\nend",
    );
    const errors = () => [...parent.querySelectorAll(".cm-mint-math-error")];
    end();
    await eventually(() => expect(errors()).toHaveLength(2));
    for (const error of errors()) expect(error.textContent).toMatch(/KaTeX parse error/);
    expect(formulas()).toEqual(["y"]);
    editor.setSelection({ anchor: 3 });
    expect(errors()).toHaveLength(1);
  });
});

describe("dialect", () => {
  const text = "a $x$ b\n\n$$\ny\n$$\n\nend";

  it("leaves dollar signs as text when math is switched off", () => {
    const { formulas, shown, end } = open(text, { dialect: { ...defaultDialect, math: false } });
    end();
    expect(formulas()).toEqual([]);
    expect(shown()).toBe(text);
  });

  it("leaves dollar signs as text in source mode", () => {
    const { formulas, shown, end } = open(text, { mode: "source" });
    end();
    expect(formulas()).toEqual([]);
    expect(shown()).toBe(text);
  });
});

// The editor and the export pipeline derive math from the same dialect switch;
// the same samples must yield the same formulas on both sides.
describe("editor and export agree on what is a formula", () => {
  const samples = [
    "costs $5 and $6 today",
    "\\$a$ b$",
    "$a\\$ b$ c",
    "$$x$$ inline with two dollars",
    "a $$ b",
    "$a$$",
    "a$b$c",
    "$ padded $ and $ one-sided$",
    "$`a`$ and `$b$`",
    "*a $b* c$",
    "$a\nb$",
    "$$$a$$$",
    "$$ x $$",
    "$$\nx^2\n$$",
    "$$x\ny\n$$",
    "para\n$$\nx\n$$",
    "$$\n$$",
    "$$$$",
    "$$ meta\nx\n$$$",
    "$$\nx\n$$ y",
    "$$$\nx\n$$\n\ny",
    "  $$\n  a\n   b\n  $$",
    "    $$\n    x\n    $$",
    "$$\na\n\nb\n$$",
    "> $$\n> a\n> $$",
    "- $$\n  x\n  $$",
    "$$\nunclosed\n\nstill",
    "| a |\n|---|\n| $x$ |",
  ];

  const exported = (text: string) =>
    [
      ...new DOMParser()
        .parseFromString(renderHtml(text, defaultDialect), "text/html")
        .querySelectorAll('annotation[encoding="application/x-tex"]'),
    ].map((el) => el.textContent);

  it.each(samples)("%j", async (sample) => {
    const text = `start\n\n${sample}`;
    const { editor, formulas } = open(text);
    editor.setSelection({ anchor: 0 });
    await eventually(() => expect(formulas()).toEqual(exported(text)));
  });
});
