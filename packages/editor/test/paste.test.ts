// Pasting rich text and plain text, through the editor core's public interface.
import { defaultDialect } from "@mint/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, type EditorOptions, type MintEditor } from "../src/index.ts";
import { finishParsing } from "./parsed.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  // Pasting depends on where the cursor is in the syntax tree: don't race the background parse.
  finishParsing(parent);
  editor.setSelection(editor.getSelection());
  const content = () => parent.querySelector<HTMLElement>(".cm-content") as HTMLElement;
  /** Paste clipboard data as a browser would. */
  const paste = (data: Record<string, string>, files: File[] = []) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        files,
        types: [...Object.keys(data), ...(files.length > 0 ? ["Files"] : [])],
        getData: (format: string) => data[format] ?? "",
      },
    });
    content().dispatchEvent(event);
  };
  return { editor, paste };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

const end = (editor: MintEditor) => editor.setSelection({ anchor: editor.getText().length });

describe("pasting rich text", () => {
  it("inserts HTML from the clipboard as Markdown at the cursor", () => {
    const { editor, paste } = open("Intro\n\n");
    end(editor);
    const html =
      '<h2>Plan</h2><ul><li>Read <a href="https://example.com">docs</a></li><li><b>Ship</b></li></ul>' +
      '<pre><code class="language-ts">let x = 1;</code></pre>';
    paste({ "text/html": html, "text/plain": "Plan\nRead docs\nShip\nlet x = 1;" });
    expect(editor.getText()).toBe(
      "Intro\n\n## Plan\n\n- Read [docs](https://example.com)\n- **Ship**\n\n```ts\nlet x = 1;\n```\n",
    );
    expect(editor.getSelection().head).toBe(editor.getText().length);
  });

  it("converts a table to a GFM table", () => {
    const { editor, paste } = open("");
    paste({
      "text/html": "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
      "text/plain": "A\tB\n1\t2",
    });
    expect(editor.getText()).toBe("| A | B |\n| - | - |\n| 1 | 2 |\n");
  });

  it("follows the editor's dialect", () => {
    const html = "<p>H<sub>2</sub>O</p>";
    const plain = open("");
    plain.paste({ "text/html": html, "text/plain": "H2O" });
    expect(plain.editor.getText()).toBe("H2O");

    const dialect = {
      ...defaultDialect,
      extended: { ...defaultDialect.extended, subscript: true },
    };
    const extended = open("", { dialect });
    extended.paste({ "text/html": html, "text/plain": "H2O" });
    expect(extended.editor.getText()).toBe("H~2~O");
  });

  it("pastes an inline fragment into the line without adding a line break", () => {
    const { editor, paste } = open("Say  now");
    editor.setSelection({ anchor: 4 });
    paste({ "text/html": "<span>a <b>bold</b> word</span>", "text/plain": "a bold word" });
    expect(editor.getText()).toBe("Say a **bold** word now");
  });

  it("writes line breaks in the document's line ending", () => {
    const { editor, paste } = open("a\r\n");
    end(editor);
    paste({ "text/html": "<p>one</p><p>two</p>", "text/plain": "one\ntwo" });
    expect(editor.getText()).toBe("a\r\none\r\n\r\ntwo\r\n");
  });

  it("undoes a paste in one step", () => {
    const { editor, paste } = open("x");
    end(editor);
    paste({ "text/html": "<p>one</p><p>two</p>", "text/plain": "one\ntwo" });
    editor.execute("undo");
    expect(editor.getText()).toBe("x");
  });

  it("pastes plain text inside a code block, and in source mode converts as well", () => {
    const { editor, paste } = open("```\ncode\n```\n");
    editor.setSelection({ anchor: 8 });
    paste({ "text/html": "<p><b>bold</b></p>", "text/plain": "bold" });
    expect(editor.getText()).toBe("```\ncodebold\n```\n");

    end(editor);
    editor.execute("toggleSourceMode");
    paste({ "text/html": "<p><b>bold</b></p>", "text/plain": "bold" });
    expect(editor.getText()).toBe("```\ncodebold\n```\n**bold**");
  });

  it("pastes plain text when the clipboard has no HTML, or comes from a code editor", () => {
    const { editor, paste } = open("");
    paste({ "text/plain": "**x** " });
    paste({
      "text/plain": "<b>a</b>",
      "text/html": '<div style="color:#fff"><span>&lt;b&gt;a&lt;/b&gt;</span></div>',
      "vscode-editor-data": '{"mode":"html"}',
    });
    expect(editor.getText()).toBe("**x** <b>a</b>");
  });

  it("leaves pasted image files to the image handling", async () => {
    const { editor, paste } = open("", {
      host: { saveImage: async (file) => `assets/${file.name}` },
    });
    const image = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    paste({ "text/html": '<img src="https://example.com/x.png">' }, [image]);
    await vi.waitFor(() => expect(editor.getText()).toBe("![shot](assets/shot.png)"));
  });
});

describe("pastePlainText", () => {
  it("inserts text verbatim, without reading it as HTML or changing it", () => {
    const { editor } = open("a  b");
    editor.setSelection({ anchor: 2 });
    expect(editor.execute("pastePlainText", "<b>*x*</b>")).toBe(true);
    expect(editor.getText()).toBe("a <b>*x*</b> b");
    editor.execute("undo");
    expect(editor.getText()).toBe("a  b");
  });
});
