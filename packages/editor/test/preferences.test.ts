// Vim key bindings and spellchecking, switched through the editor core's public interface.
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, type EditorOptions, type MintEditor } from "../src/index.ts";
import { finishParsing } from "./parsed.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  finishParsing(parent);
  editor.setSelection(editor.getSelection());
  const content = () => parent.querySelector<HTMLElement>(".cm-content") as HTMLElement;
  const press = (...keys: string[]) => {
    for (const key of keys) {
      content().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    }
  };
  return { editor, parent, content, press };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

describe("preferences", () => {
  it("are off unless asked for", () => {
    const { editor } = open("x");
    expect(editor.getPreferences()).toEqual({ vim: false, spellcheck: false });
    const configured = open("x", { vim: true, spellcheck: true }).editor;
    expect(configured.getPreferences()).toEqual({ vim: true, spellcheck: true });
  });
});

describe("Vim key bindings", () => {
  it("make keys commands in normal mode", () => {
    const { editor, press } = open("abc def", { vim: true });
    editor.setSelection({ anchor: 0 });
    press("x");
    expect(editor.getText()).toBe("bc def");
    press("d", "w");
    expect(editor.getText()).toBe("def");
  });

  it("can be switched on and off while editing, leaving the text alone", () => {
    const { editor, press } = open("abc");
    editor.setSelection({ anchor: 0 });
    press("x");
    expect(editor.getText()).toBe("abc");

    editor.configure({ vim: true });
    expect(editor.getPreferences().vim).toBe(true);
    press("x");
    expect(editor.getText()).toBe("bc");

    editor.configure({ vim: false });
    press("x");
    expect(editor.getText()).toBe("bc");
  });

  it("take precedence over the editor's own keys", () => {
    const { editor, press } = open("- a\n- b", { vim: true });
    editor.setSelection({ anchor: 3 });
    // Enter moves down a line in normal mode instead of continuing the list.
    press("Enter");
    expect(editor.getText()).toBe("- a\n- b");
  });
});

describe("spellchecking", () => {
  it("asks the system to check the text when switched on", () => {
    const { editor, content } = open("Helo wrld");
    expect(content().getAttribute("spellcheck")).toBe("false");
    editor.configure({ spellcheck: true });
    expect(content().getAttribute("spellcheck")).toBe("true");
    expect(editor.getPreferences()).toEqual({ vim: false, spellcheck: true });
    editor.configure({ spellcheck: false });
    expect(content().getAttribute("spellcheck")).toBe("false");
  });

  it("leaves code, math and URLs unchecked", () => {
    const { editor, parent } = open(
      "Text `cdoe` $x_y$ <https://exmple.com>\n\n```js\nconst vlaue = 1;\n```\n\nend",
      { spellcheck: true, mode: "source" },
    );
    editor.setSelection({ anchor: 0 });
    const unchecked = [...parent.querySelectorAll('[spellcheck="false"]')].map(
      (e) => e.textContent,
    );
    expect(unchecked).toEqual(
      expect.arrayContaining(["`cdoe`", "$x_y$", "https://exmple.com", "const vlaue = 1;"]),
    );
    expect(unchecked.join(" ")).not.toContain("Text");
    expect(unchecked.join(" ")).not.toContain("end");
  });
});
