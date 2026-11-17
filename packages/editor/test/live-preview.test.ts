// Live preview through the editor core's public interface: what the user sees
// (the rendered text of the mounted editor) as the selection moves.
import { defaultDialect } from "@mint/markdown";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEditor,
  type EditorOptions,
  type LinkTarget,
  type MintEditor,
} from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  /** The text as displayed: hidden markers are absent. */
  const shown = () =>
    [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
  return { editor, parent, shown };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

describe("span reveal", () => {
  it("renders inline spans with their markers hidden while the cursor is elsewhere", () => {
    const { editor, shown } = open(
      "**bold** *it* ~~del~~ `code` [link](https://example.com)\n\nend",
    );
    editor.setSelection({ anchor: editor.getText().length });
    expect(shown()).toBe("bold it del code link\n\nend");
  });

  it("reveals only the markers of the span the cursor touches", () => {
    const { editor, shown } = open("**bold** and *it* and [link](https://example.com)");
    editor.setSelection({ anchor: 3 }); // inside "bold"
    expect(shown()).toBe("**bold** and it and link");
    editor.setSelection({ anchor: 14 }); // inside "it"
    expect(shown()).toBe("bold and *it* and link");
    editor.setSelection({ anchor: 24 }); // inside "link"
    expect(shown()).toBe("bold and it and [link](https://example.com)");
  });

  it("reveals a span when the cursor sits right after its closing marker", () => {
    const { editor, shown } = open("**bold** x");
    editor.setSelection({ anchor: 8 });
    expect(shown()).toBe("**bold** x");
  });

  it("reveals every span a selection crosses, and nothing else", () => {
    const { editor, shown } = open("*a* **b** `c` d");
    editor.setSelection({ anchor: 1, head: 6 });
    expect(shown()).toBe("*a* **b** c d");
  });

  it("lets the user delete a revealed marker, e.g. un-bold half a word", () => {
    const { editor, shown } = open("**hello** world");
    editor.setSelection({ anchor: 4 }); // "**he|llo**"
    editor.execute("insertText", "**");
    expect(editor.getText()).toBe("**he**llo** world");
    editor.setSelection({ anchor: 9, head: 11 }); // the trailing "**" of the original span
    editor.execute("insertText", "");
    expect(editor.getText()).toBe("**he**llo world");
    editor.setSelection({ anchor: editor.getText().length });
    expect(shown()).toBe("hello world");
  });

  it("hides autolink brackets and keeps bare URLs as they are", () => {
    const { editor, shown } = open("<https://a.example> https://b.example\n\nx");
    editor.setSelection({ anchor: editor.getText().length });
    expect(shown()).toBe("https://a.example https://b.example\n\nx");
  });
});

describe("dialect", () => {
  const text = "~~del~~ ^sup^ H~2~O\n\nend";

  it("renders only the syntax the dialect enables: extended syntax is off by default", () => {
    const { editor, shown } = open(text);
    editor.setSelection({ anchor: editor.getText().length });
    expect(shown()).toBe("del ^sup^ H~2~O\n\nend");
  });

  it("renders extended syntax once it is switched on", () => {
    const extended = { ...defaultDialect.extended, superscript: true, subscript: true };
    const { editor, shown } = open(text, { dialect: { ...defaultDialect, extended } });
    editor.setSelection({ anchor: editor.getText().length });
    expect(shown()).toBe("del sup H2O\n\nend");
  });

  it("leaves GFM syntax as text when GFM is off", () => {
    const { editor, shown } = open(text, { dialect: { ...defaultDialect, gfm: false } });
    editor.setSelection({ anchor: editor.getText().length });
    expect(shown()).toBe("~~del~~ ^sup^ H~2~O\n\nend");
  });
});

describe("source mode", () => {
  it("shows the raw text after toggling, keeping text and cursor", () => {
    const { editor, shown } = open("**bold** x\n\nend");
    editor.setSelection({ anchor: 13 });
    expect(editor.getMode()).toBe("livePreview");
    expect(editor.execute("toggleSourceMode")).toBe(true);
    expect(editor.getMode()).toBe("source");
    expect(shown()).toBe("**bold** x\n\nend");
    expect(editor.getText()).toBe("**bold** x\n\nend");
    expect(editor.getSelection()).toEqual({ anchor: 13, head: 13 });

    editor.execute("toggleSourceMode");
    expect(editor.getMode()).toBe("livePreview");
    expect(shown()).toBe("bold x\n\nend");
    expect(editor.getSelection()).toEqual({ anchor: 13, head: 13 });
  });

  it("can start in source mode and reports mode changes to subscribers", () => {
    const { editor, shown } = open("*a*", { mode: "source" });
    editor.setSelection({ anchor: 3 });
    expect(shown()).toBe("*a*");
    const events: string[] = [];
    editor.subscribe((event) => events.push(event.type));
    editor.execute("toggleSourceMode");
    expect(events).toEqual(["mode"]);
  });
});

describe("opening links", () => {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? { metaKey: true } : { ctrlKey: true };

  function openWithLinks(text: string) {
    const opened: LinkTarget[] = [];
    const view = open(text, { host: { openLink: (link) => opened.push(link) } });
    view.editor.setSelection({ anchor: view.editor.getText().length });
    /** Click the rendered link whose visible text is `label`. */
    const click = (label: string, modifiers: MouseEventInit = mod) => {
      const link = [...view.parent.querySelectorAll("[class*=link]")].find(
        (el) => el.textContent === label,
      );
      if (!link) throw new Error(`No rendered link "${label}"`);
      link.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...modifiers }),
      );
    };
    return { ...view, opened, click };
  }

  it("hands an external link to the host when it is ⌘-clicked", () => {
    const { click, opened } = openWithLinks("See [MINT](https://example.com/mint) here.\n");
    click("MINT");
    expect(opened).toEqual([{ kind: "external", url: "https://example.com/mint" }]);
  });

  it("hands a local Markdown link to the host as a document path", () => {
    const { click, opened } = openWithLinks("[notes](../notes/a%20b.md#top) x\n");
    click("notes");
    expect(opened).toEqual([{ kind: "document", path: "../notes/a b.md" }]);
  });

  it("follows reference links, autolinks and bare URLs", () => {
    const { click, opened } = openWithLinks(
      "[ref link][r] <https://a.example> https://b.example\n\n[r]: other.md\n",
    );
    click("ref link");
    click("https://a.example");
    click("https://b.example");
    expect(opened).toEqual([
      { kind: "document", path: "other.md" },
      { kind: "external", url: "https://a.example" },
      { kind: "external", url: "https://b.example" },
    ]);
  });

  it("ignores plain clicks and links MINT cannot open", () => {
    const { click, opened, editor } = openWithLinks("[a](https://a.example) [img](pic.png)\n");
    click("a", {});
    click("img");
    expect(opened).toEqual([]);
    expect(editor.getText()).toBe("[a](https://a.example) [img](pic.png)\n");
  });
});
