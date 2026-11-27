// Raw HTML blocks (a README's centred banner and badges) in live preview,
// through the editor core's public interface. These tests play the host.
import { afterEach, describe, expect, it, vi } from "vitest";
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
  /** The source text as displayed: replaced source is absent. */
  const shown = () =>
    [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
  const blocks = () => [...parent.querySelectorAll<HTMLElement>(".cm-mint-html")];
  const images = () => [...parent.querySelectorAll<HTMLImageElement>(".cm-mint-html img")];
  return { editor, parent, shown, blocks, images };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

const end = (editor: MintEditor) => editor.setSelection({ anchor: editor.getText().length });

const readme = [
  '<p align="center">',
  '<img alt="" src="docs/graphics/logos/banner_readme.png"/>',
  "</p>",
  "",
  '<a href="https://github.com/x/y/releases"><img src="https://img.shields.io/github/v/release/x/y" alt="release"/></a>',
  '<a href="https://ci.example/y"><img src="https://img.shields.io/badge/build-ok-green" alt="build"/></a>',
  "",
  "# Title",
].join("\n");

describe("HTML blocks in live preview", () => {
  it("renders a README's centred banner and badge line in place of their source", () => {
    const resolveImageUrl = vi.fn((path: string) => `asset://${path}`);
    const { editor, shown, blocks, images } = open(readme, { host: { resolveImageUrl } });
    end(editor);
    expect(shown()).toBe("\n\n# Title");
    expect(blocks()[0]?.querySelector("p")?.getAttribute("align")).toBe("center");
    expect(images().map((img) => [img.getAttribute("src"), img.alt])).toEqual([
      ["asset://docs/graphics/logos/banner_readme.png", ""],
      ["https://img.shields.io/github/v/release/x/y", "release"],
      ["https://img.shields.io/badge/build-ok-green", "build"],
    ]);
    expect(resolveImageUrl).toHaveBeenCalledWith("docs/graphics/logos/banner_readme.png");
  });

  it("shows the source while the cursor is on one of its lines", () => {
    const { editor, shown } = open(readme);
    editor.setSelection({ anchor: readme.indexOf("<img") });
    expect(shown().split("\n").slice(0, 3)).toEqual(readme.split("\n").slice(0, 3));
    expect(shown().split("\n")[3]).toBe("");
  });

  it("reveals the source when the rendered block is clicked", () => {
    const { editor, shown, blocks } = open('<div align="center">\n<b>hi</b>\n</div>\n\nend');
    end(editor);
    blocks()[0]?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(shown()).toBe('<div align="center">\n<b>hi</b>\n</div>\n\nend');
    expect(editor.getSelection().anchor).toBeLessThan(30);
  });

  it("strips scripts, event handlers, javascript: URLs, frames and styles", () => {
    const evil = [
      '<div onclick="alert(1)"><script>alert(2)</script><img src="x.png" onerror="alert(3)">',
      '<a href="javascript:alert(4)">j</a><iframe src="https://e.com"></iframe>',
      "<style>body{display:none}</style><svg><script>alert(5)</script></svg>",
      "</div>",
      "",
      "end",
    ].join("\n");
    const { editor, blocks } = open(evil);
    end(editor);
    const html = blocks()
      .map((b) => b.innerHTML)
      .join("");
    expect(html).toContain("<img");
    expect(html).not.toMatch(/script|onclick|onerror|javascript:|iframe|style|display:none/i);
  });

  it("loads data: images directly and shows the placeholder for an image that fails", () => {
    const resolveImageUrl = vi.fn(() => null);
    const { editor, images, parent } = open(
      '<div>\n<img src="data:image/png;base64,AAAA" alt="dot">\n<img src="gone.png" alt="gone">\n</div>\n\nend',
      { host: { resolveImageUrl } },
    );
    end(editor);
    expect(images().map((img) => img.getAttribute("src"))).toEqual(["data:image/png;base64,AAAA"]);
    const missing = [...parent.querySelectorAll(".cm-mint-html .cm-mint-image-missing")];
    expect(missing.map((m) => m.textContent)).toEqual(["gone"]);
    images()[0]?.dispatchEvent(new Event("error"));
    expect(
      [...parent.querySelectorAll(".cm-mint-html .cm-mint-image-missing")].map(
        (m) => m.textContent,
      ),
    ).toEqual(["dot", "gone"]);
  });

  it("opens a link inside the block on ⌘/Ctrl-click, and only reveals on a plain click", () => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const opened: LinkTarget[] = [];
    const { editor, parent, shown } = open(
      '<p>\n<a href="https://example.com/x">ext</a> <a href="notes/a%20b.md#top">doc</a>\n</p>\n\nend',
      { host: { openLink: (link) => opened.push(link) } },
    );
    end(editor);
    const click = (label: string, modifiers: MouseEventInit) =>
      [...parent.querySelectorAll(".cm-mint-html a")]
        .find((a) => a.textContent === label)
        ?.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...modifiers }),
        );
    const mod = isMac ? { metaKey: true } : { ctrlKey: true };
    click("ext", mod);
    click("doc", mod);
    expect(opened).toEqual([
      { kind: "external", url: "https://example.com/x" },
      { kind: "document", path: "notes/a b.md", fragment: "top" },
    ]);
    expect(shown()).toBe("\nend");
    click("ext", {});
    expect(opened).toHaveLength(2);
    expect(shown()).toContain('<a href="https://example.com/x">ext</a>');
  });

  it("hides HTML comment blocks until the cursor enters them", () => {
    const { editor, shown } = open("<!-- note to self -->\n\nend");
    end(editor);
    expect(shown()).not.toContain("note to self");
    editor.setSelection({ anchor: 5 });
    expect(shown()).toContain("<!-- note to self -->");
  });

  it("leaves inline HTML within a sentence to the text", () => {
    const { editor, shown, blocks } = open("Press <kbd>Ctrl</kbd> now\n\nend");
    end(editor);
    expect(blocks()).toEqual([]);
    expect(shown()).toContain("Press <kbd>Ctrl</kbd> now");
  });

  it("is not rendered in source mode, and never changes the text", () => {
    const text = `${readme.replaceAll("\n", "\r\n")}\r\n`;
    const { editor, blocks } = open(text);
    end(editor);
    editor.setSelection({ anchor: 3 });
    end(editor);
    expect(editor.getText()).toBe(text);
    editor.execute("toggleSourceMode");
    expect(blocks()).toEqual([]);
    expect(editor.getText()).toBe(text);
  });
});
