// Extended syntax ([TOC], ==highlight==, ^superscript^, ~subscript~) through
// the editor core's public interface: what the mounted editor shows for each
// dialect switch, and agreement with the export pipeline on the same samples.
import { type Dialect, defaultDialect, type ExtendedSyntax, renderHtml } from "@mint/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, type EditorOptions, type MintEditor } from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  /** The text as displayed: hidden markers are absent. */
  const shown = () =>
    [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
  /** Text shown with a highlight / superscript / subscript style. */
  const styled = (kind: "highlight" | "superscript" | "subscript") =>
    [...parent.querySelectorAll(`.cm-mint-${kind}`)].map((el) => el.textContent).join("|");
  const end = () => editor.setSelection({ anchor: editor.getText().length });
  return { editor, parent, shown, styled, end };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

/**
 * Wait for an assertion to hold. On a loaded machine CodeMirror may finish
 * parsing a document in the background, and spans render once it has.
 */
const eventually = (assertion: () => void) => vi.waitFor(assertion, { timeout: 10_000 });

const withExtended = (switches: Partial<ExtendedSyntax>): Dialect => ({
  ...defaultDialect,
  extended: { ...defaultDialect.extended, ...switches },
});

describe("highlight", () => {
  const text = "a ==marked **text**== b\n\nend";

  it("is plain text by default", async () => {
    const { shown, styled, end } = open(text);
    end();
    await eventually(() => expect(shown()).toBe("a ==marked text== b\n\nend"));
    await eventually(() => expect(styled("highlight")).toBe(""));
  });

  it("renders ==text== highlighted with its markers hidden when enabled", async () => {
    const { shown, styled, end } = open(text, { dialect: withExtended({ highlight: true }) });
    end();
    await eventually(() => expect(shown()).toBe("a marked text b\n\nend"));
    await eventually(() => expect(styled("highlight")).toContain("marked"));
  });

  it("reveals the markers while the cursor touches the highlight", async () => {
    const { editor, shown, styled } = open(text, { dialect: withExtended({ highlight: true }) });
    editor.setSelection({ anchor: 6 });
    await eventually(() => expect(shown()).toBe("a ==marked text== b\n\nend"));
    await eventually(() => expect(styled("highlight")).toContain("marked"));
  });
});

describe("superscript and subscript", () => {
  it("render x^2^ and H~2~O with their markers hidden when enabled", async () => {
    const { shown, styled, end } = open("x^2^ H~2~O ~~del~~\n\nend", {
      dialect: withExtended({ superscript: true, subscript: true }),
    });
    end();
    await eventually(() => expect(shown()).toBe("x2 H2O del\n\nend"));
    await eventually(() => expect(styled("superscript")).toBe("2"));
    await eventually(() => expect(styled("subscript")).toBe("2"));
  });

  it("are text when the run holds a space", async () => {
    const { shown, end } = open("a^b c^ d~e f~\n\nend", {
      dialect: withExtended({ superscript: true, subscript: true }),
    });
    end();
    await eventually(() => expect(shown()).toBe("a^b c^ d~e f~\n\nend"));
  });
});

describe("switching extended syntax on and off", () => {
  it("takes effect immediately in an open editor, keeping text and selection", async () => {
    const text = "==a== ^b^ ~c~\n\nend";
    const { editor, shown, end } = open(text);
    end();
    await eventually(() => expect(shown()).toBe("==a== ^b^ ~c~\n\nend"));

    editor.setDialect(withExtended({ highlight: true }));
    await eventually(() => expect(shown()).toBe("a ^b^ ~c~\n\nend"));
    editor.setDialect(withExtended({ highlight: true, superscript: true, subscript: true }));
    await eventually(() => expect(shown()).toBe("a b c\n\nend"));
    editor.setDialect(defaultDialect);
    await eventually(() => expect(shown()).toBe("==a== ^b^ ~c~\n\nend"));

    expect(editor.getText()).toBe(text);
    expect(editor.getSelection()).toEqual({ anchor: text.length, head: text.length });
  });
});

describe("switching extended syntax in table cells", () => {
  it("re-renders the cells of a table widget at once", async () => {
    const { editor, parent, end } = open("| a |\n|---|\n| ==b== |\n\nend");
    end();
    await eventually(() => expect(parent.textContent).toContain("==b=="));
    editor.setDialect(withExtended({ highlight: true }));
    await eventually(() => expect(parent.querySelector("mark")?.textContent).toBe("b"));
  });
});

describe("table of contents", () => {
  const text = "# Guide\n\n[TOC]\n\n## Set *up*\n\n### Install\n\nend";
  const entries = (parent: HTMLElement) =>
    [...parent.querySelectorAll(".cm-mint-toc a")].map(
      (a) => `${a.getAttribute("data-level")} ${a.textContent}`,
    );

  it("is ordinary paragraph text by default", async () => {
    const { parent, shown, end } = open(text);
    end();
    // (Live preview treats any `[text]` as a possible reference link.)
    await eventually(() => expect(shown()).toContain("\nTOC\n"));
    await eventually(() => expect(parent.querySelector(".cm-mint-toc")).toBeNull());
  });

  it("lists the document's headings in place of the [TOC] line when enabled", async () => {
    const { parent, shown, end } = open(text, { dialect: withExtended({ toc: true }) });
    end();
    await eventually(() => expect(entries(parent)).toEqual(["1 Guide", "2 Set up", "3 Install"]));
    await eventually(() => expect(shown()).not.toContain("[TOC]"));
  });

  it("shows the [TOC] source while the cursor is on its line", async () => {
    const { editor, parent, shown, end } = open(text, { dialect: withExtended({ toc: true }) });
    end();
    await eventually(() => expect(entries(parent)).toHaveLength(3));
    editor.setSelection({ anchor: 11 });
    expect(parent.querySelector(".cm-mint-toc")).toBeNull();
    expect(shown()).toContain("[TOC]");
  });

  it("follows the headings as they are edited", async () => {
    const { editor, parent, end } = open(text, { dialect: withExtended({ toc: true }) });
    end();
    editor.execute("insertText", "\n\n## Next");
    await eventually(() =>
      expect(entries(parent)).toEqual(["1 Guide", "2 Set up", "3 Install", "2 Next"]),
    );
  });

  it("moves the cursor to a heading when its entry is clicked", async () => {
    const { editor, parent, end } = open(text, { dialect: withExtended({ toc: true }) });
    end();
    await eventually(() => expect(entries(parent)).toHaveLength(3));
    const entry = [...parent.querySelectorAll(".cm-mint-toc a")][2] as HTMLElement;
    entry.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    const install = text.indexOf("### Install");
    expect(editor.getSelection()).toEqual({ anchor: install, head: install });
  });
});

// The editor and the export pipeline derive extended syntax from the same
// dialect switches; the same samples must yield the same spans on both sides.
describe("editor and export agree on extended syntax", () => {
  const samples = [
    // ==highlight==
    "==a==",
    "a==b==c",
    "== a ==",
    "==a ==b",
    "=== a ===",
    "==a=== b==",
    "\\==a==",
    "==a **b** c==",
    "**==a==**",
    "==a\nb==",
    "==a== ==b==",
    "`==a==` and ==`b`==",
    "[==a==](u) ==[b](u)==",
    "a ==b",
    "==a~~b~~c==",
    "==a=b==",
    "x = = y == z ==",
    "Title\n==",
    // ^superscript^ and ~subscript~
    "x^2^",
    "^a b^",
    "^^a^",
    "^a^^",
    "a^b^c^d^",
    "^a\\^b^",
    "^a\\ b^",
    "^a\\b^",
    "^`a`^ and `^b^`",
    "^*a*^ and *^b^*",
    "^[a](u)^",
    "[a^b](c^)",
    "H~2~O",
    "~a~~b~",
    "~~a~~",
    "x~~~a~",
    "~a",
    "~a\nb~",
    "~a~ ~~b~~ ^c^",
    "x^2^~3~",
    "a^b",
    "^a^ ^",
    "~~a~b~~",
    "\\^a^",
    "^\\^^",
    "| a |\n|---|\n| ^b^ ~c~ ==d== |",
    // [TOC]
    "[TOC]",
    "  [TOC]  ",
    "a\n[TOC]",
    "[TOC] x",
    "[TOC]\n# H",
    "> [TOC]",
    "- [TOC]",
    "    [TOC]",
    "[toc]",
    "# A\n\n[TOC]\n\n## B *c*\n\n> ### D",
  ];

  const allOn = withExtended({ toc: true, highlight: true, superscript: true, subscript: true });
  const kinds = { highlight: "mark", superscript: "sup", subscript: "sub", strikethrough: "del" };
  const skipped = ".cm-mint-toc, .cm-mint-math, nav.toc, .katex";

  /**
   * The text of the document in runs of the same styling (highlight,
   * superscript, subscript, strikethrough), keeping only styled runs;
   * whitespace and backslash escapes are ignored.
   */
  function styledRuns(root: Element, kindOf: (el: Element) => string | undefined): string[] {
    const runs: { kind: string; text: string }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(skipped)) continue;
      const styles: string[] = [];
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        const kind = kindOf(el);
        if (kind && !styles.includes(kind)) styles.push(kind);
      }
      const kind = styles.sort().join("+");
      const text = (node.textContent ?? "")
        .replace(/\s+/g, "")
        .replace(/\\([!-/:-@[-`{-~])/g, "$1");
      if (!text) continue;
      const last = runs[runs.length - 1];
      if (last && last.kind === kind) last.text += text;
      else runs.push({ kind, text });
    }
    return runs.filter((run) => run.kind).map((run) => `${run.kind}:${run.text}`);
  }

  const exportKind = (el: Element) =>
    Object.values(kinds).includes(el.tagName.toLowerCase()) ? el.tagName.toLowerCase() : undefined;
  // Live preview styles spans with classes; block widgets (table cells) show rendered HTML.
  const editorKind = (el: Element) =>
    Object.entries(kinds).find(([name]) => el.classList.contains(`cm-mint-${name}`))?.[1] ??
    exportKind(el);

  const exported = (text: string, dialect: Dialect) => {
    const html = new DOMParser().parseFromString(renderHtml(text, dialect), "text/html");
    return {
      runs: styledRuns(html.body, exportKind),
      tocs: [...html.querySelectorAll("nav.toc")].map((nav) =>
        [...nav.querySelectorAll("a")].map((a) => a.textContent),
      ),
    };
  };

  it("compares the styled spans and tables of contents of both sides", async () => {
    const text = "# H\n\n[TOC]\n\n==a== ^b^ ~c~ ~~d~~";
    const expected = { runs: ["mark:a", "sup:b", "sub:c", "del:d"], tocs: [["H"]] };
    expect(exported(text, allOn)).toEqual(expected);
    const { editor, parent } = open(text, { dialect: allOn });
    editor.setSelection({ anchor: 0 });
    await vi.waitFor(() =>
      expect(styledRuns(parent.querySelector(".cm-content") as Element, editorKind)).toEqual(
        expected.runs,
      ),
    );
  });

  describe.each([
    ["every extended syntax on", allOn],
    ["the default dialect", defaultDialect],
  ])("with %s", (_name, dialect) => {
    it.each(samples)("%j", async (sample) => {
      // The editor may finish parsing in the background; the closing
      // strikethrough shows when it has reached the end of the document.
      const text = `start\n\n${sample}\n\nx ~~end~~`;
      const { editor, parent } = open(text, { dialect });
      editor.setSelection({ anchor: 0 });
      const shown = () => ({
        runs: styledRuns(parent.querySelector(".cm-content") as Element, editorKind),
        tocs: [...parent.querySelectorAll(".cm-mint-toc")].map((nav) =>
          [...nav.querySelectorAll("a")].map((a) => a.textContent),
        ),
      });
      await vi.waitFor(() => expect(shown().runs.at(-1)).toBe("del:end"), { timeout: 10_000 });
      expect(shown()).toEqual(exported(text, dialect));
    });
  });
});
