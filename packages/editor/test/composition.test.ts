// IME composition (Chinese, Japanese, Korean input) in live preview, through
// the editor core's public interface and the DOM events an input method sends.
// The input method edits the text in the DOM while composing; the editor reads
// it back. The rendered markers must not change under a composition (rebuilding
// decorations there cancels it in real browsers), and the text must come out right.
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, type MintEditor } from "../src/index.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text });
  mounted.push({ editor, parent });
  const content = parent.querySelector(".cm-content") as HTMLElement;
  const shown = () =>
    [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
  return { editor, parent, content, shown };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

/** Let the editor read DOM changes (it observes them with a MutationObserver). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The last text node holding `text` in the content, and the offset of `text` in it. */
function textNodeWith(content: HTMLElement, text: string): { node: Text; offset: number } {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let found: { node: Text; offset: number } | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const offset = node.textContent?.lastIndexOf(text) ?? -1;
    if (offset >= 0) found = { node: node as Text, offset };
  }
  if (!found) throw new Error(`no text node with ${JSON.stringify(text)}`);
  return found;
}

/**
 * Compose `steps` (each the input method's current text, e.g. pinyin, then the
 * chosen characters) right after `anchorText` in the DOM, as an input method does.
 * Returns what was shown after each step.
 */
async function compose(
  content: HTMLElement,
  shown: () => string,
  anchorText: string,
  steps: readonly string[],
): Promise<string[]> {
  const seen: string[] = [];
  const { node, offset } = textNodeWith(content, anchorText);
  const at = offset + anchorText.length;
  const before = node.data.slice(0, at);
  const after = node.data.slice(at);
  content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
  for (const step of steps) {
    content.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: step }));
    node.data = before + step + after;
    const selection = document.getSelection();
    selection?.collapse(node, before.length + step.length);
    await settle();
    seen.push(shown());
  }
  content.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true, data: steps.at(-1) ?? "" }),
  );
  await settle();
  return seen;
}

describe("IME composition in live preview", () => {
  it("composes Chinese inside bold text", async () => {
    const { editor, content, shown } = open("**粗体**\n\nend");
    editor.setSelection({ anchor: 4 }); // after "粗体", inside the span: markers revealed
    editor.focus();
    const before = shown();

    const steps = ["c", "ce", "测"];
    const seen = await compose(content, shown, "粗体", steps);

    expect(editor.getText()).toBe("**粗体测**\n\nend");
    // The revealed markers stayed exactly as they were while composing.
    expect(seen.map((view, i) => view.replace(steps[i] ?? "", ""))).toEqual(
      steps.map(() => before),
    );
  });

  it("leaves the markers alone while composing right after a span, where moving on would hide them", async () => {
    const { editor, content, shown } = open("**粗体**\n\nend");
    editor.setSelection({ anchor: 6 }); // right after the closing marker: revealed
    editor.focus();
    expect(shown()).toBe("**粗体**\n\nend");

    const seen = await compose(content, shown, "**", ["ce", "测"]);

    // Mid-composition the cursor has left the span, but nothing is rebuilt until the end.
    expect(seen).toEqual(["**粗体**ce\n\nend", "**粗体**测\n\nend"]);
    expect(editor.getText()).toBe("**粗体**测\n\nend");
    expect(shown()).toBe("粗体测\n\nend");
  });

  it("composes inside a link's text and keeps its URL", async () => {
    const { editor, content } = open("[链接](https://example.com)\n\nend");
    editor.setSelection({ anchor: 3 });
    editor.focus();

    await compose(content, () => "", "链接", ["wen", "文"]);

    expect(editor.getText()).toBe("[链接文](https://example.com)\n\nend");
  });

  it("composes Japanese at the end of a heading", async () => {
    const { editor, content } = open("# 見出し\n\nend");
    editor.setSelection({ anchor: 6 });
    editor.focus();

    await compose(content, () => "", "見出し", ["に", "にほ", "日本"]);

    expect(editor.getText()).toBe("# 見出し日本\n\nend");
  });

  it("composes Korean in a list item", async () => {
    const { editor, content } = open("- 항목\n\nend");
    editor.setSelection({ anchor: 4 });
    editor.focus();

    await compose(content, () => "", "항목", ["ㅎ", "하", "한"]);

    expect(editor.getText()).toBe("- 항목한\n\nend");
  });

  it("hides the markers again once the composition ends and the cursor leaves", async () => {
    const { editor, content, shown } = open("**粗体**\n\nend");
    editor.setSelection({ anchor: 4 });
    editor.focus();
    await compose(content, shown, "粗体", ["c", "测"]);

    editor.setSelection({ anchor: editor.getText().length });

    expect(shown()).toBe("粗体测\n\nend");
  });
});
