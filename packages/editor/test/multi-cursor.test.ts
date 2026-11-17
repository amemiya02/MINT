// Multiple selections through the editor core's public interface.
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, type MintEditor } from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text });
  mounted.push({ editor, parent });
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

describe("multiple cursors", () => {
  it("types the same text at every cursor", () => {
    const { editor } = open("one\ntwo\nthree\n");
    editor.setSelections([{ anchor: 3 }, { anchor: 7 }, { anchor: 13 }]);

    editor.execute("insertText", "!");

    expect(editor.getText()).toBe("one!\ntwo!\nthree!\n");
    expect(editor.getSelections()).toEqual([
      { anchor: 4, head: 4 },
      { anchor: 9, head: 9 },
      { anchor: 16, head: 16 },
    ]);
  });

  it("selects the next occurrence of the selected word, then replaces both at once", () => {
    const { editor } = open("cat dog cat bird cat");
    editor.setSelection({ anchor: 0, head: 3 });

    editor.execute("selectNextOccurrence");
    expect(editor.getSelections()).toEqual([
      { anchor: 0, head: 3 },
      { anchor: 8, head: 11 },
    ]);

    editor.execute("insertText", "fox");
    expect(editor.getText()).toBe("fox dog fox bird cat");
  });

  it("selects the word at a bare cursor first", () => {
    const { editor } = open("alpha beta alpha");
    editor.setSelection({ anchor: 2 });

    editor.execute("selectNextOccurrence");

    expect(editor.getSelections()).toEqual([{ anchor: 0, head: 5 }]);
  });

  it("undoes an edit at several cursors in one step", () => {
    const { editor } = open("a\nb\n");
    editor.setSelections([{ anchor: 1 }, { anchor: 3 }]);
    editor.execute("insertText", "x");

    editor.execute("undo");

    expect(editor.getText()).toBe("a\nb\n");
  });

  it("reveals the markers of every span a cursor is in, in live preview", () => {
    const { editor, shown } = open("**one** and *two* and `three`\n\nend");
    editor.setSelections([{ anchor: 3 }, { anchor: 14 }]);

    expect(shown()).toBe("**one** and *two* and three\n\nend");
  });

  it("keeps file offsets for every range of a CRLF document", () => {
    const { editor } = open("ab\r\ncd\r\n");
    editor.setSelections([{ anchor: 2 }, { anchor: 6 }]);

    editor.execute("insertText", "!");

    expect(editor.getText()).toBe("ab!\r\ncd!\r\n");
  });
});
