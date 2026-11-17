// Mermaid block widgets through the editor core's public interface. Mermaid
// itself needs real layout, which jsdom lacks, so the library is replaced by a
// stand-in that "renders" a diagram's source into an <svg> and rejects
// sources containing "error"; real diagrams are covered by the E2E tests.
import { defaultDialect } from "@mint/markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor, type EditorOptions, type MintEditor, renderMermaid } from "../src/index.ts";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, source: string) => {
    if (source.includes("error")) throw new Error(`Parse error on line 2: ${source}`);
    return { svg: `<svg data-source="${source.trim()}"></svg>` };
  }),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  const diagrams = () => [...parent.querySelectorAll(".cm-mint-mermaid")];
  const shown = () =>
    [...parent.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
  return { editor, parent, diagrams, shown };
}
beforeEach(() => {
  mermaid.render.mockClear();
});
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

const flowchart = "```mermaid\ngraph TD\n  A --> B\n```";

describe("mermaid block widget", () => {
  it("renders a mermaid code block as a diagram while the cursor is elsewhere", async () => {
    const { diagrams, shown } = open(`intro\n\n${flowchart}\n`);
    expect(shown()).toBe("intro\n\n");
    await vi.waitFor(() =>
      expect(diagrams()[0]?.querySelector("svg")?.getAttribute("data-source")).toBe(
        "graph TD\n  A --> B",
      ),
    );
  });

  it("shows the source while the cursor is on one of the block's lines", async () => {
    const { editor, diagrams, shown } = open(`intro\n\n${flowchart}\n`);
    editor.setSelection({ anchor: editor.getText().indexOf("A -->") });
    expect(shown()).toBe(`intro\n\n${flowchart}\n`);
    expect(diagrams()).toEqual([]);

    editor.setSelection({ anchor: 0 });
    expect(shown()).toBe("intro\n\n");
    expect(diagrams()).toHaveLength(1);
  });

  it("re-renders the diagram after its source is edited", async () => {
    const { editor, diagrams } = open(`${flowchart}\n\nend`);
    editor.setSelection({ anchor: editor.getText().indexOf("B\n") + 1 });
    editor.execute("insertText", " --> C");
    editor.setSelection({ anchor: editor.getText().length });
    await vi.waitFor(() =>
      expect(diagrams()[0]?.querySelector("svg")?.getAttribute("data-source")).toBe(
        "graph TD\n  A --> B --> C",
      ),
    );
    expect(editor.getText()).toBe("```mermaid\ngraph TD\n  A --> B --> C\n```\n\nend");
  });

  it("shows Mermaid's error message when the diagram has a syntax error", async () => {
    const { diagrams } = open("x\n\n```mermaid\ngraph TD\n  A -- error\n```\n");
    await vi.waitFor(() =>
      expect(diagrams()[0]?.querySelector("[role=alert]")?.textContent).toContain(
        "Parse error on line 2",
      ),
    );
    expect(diagrams()[0]?.querySelector("svg")).toBeNull();
  });

  it("leaves other code blocks and fences inside containers alone", () => {
    const text = "x\n\n```js\nlet a = 1\n```\n\n> ```mermaid\n> graph TD\n> ```\n";
    const { diagrams, shown } = open(text);
    expect(diagrams()).toEqual([]);
    expect(shown()).toContain("let a = 1");
    expect(shown()).toContain("graph TD");
  });

  it("takes over only mermaid fences: other fences keep the code-block rendering", async () => {
    const text = `${flowchart}\n\n\u0060\u0060\u0060js\nlet a = 1\n\u0060\u0060\u0060\n\nend`;
    const { editor, parent, diagrams } = open(text);
    editor.setSelection({ anchor: editor.getText().length });
    await vi.waitFor(() => {
      expect(diagrams()).toHaveLength(1);
      // The js block is drawn as a code block (language label in place of the fence)...
      expect(parent.querySelector(".cm-mint-code-language")?.textContent).toBe("js");
      expect(parent.querySelectorAll(".cm-mint-codeblock").length).toBeGreaterThan(0);
    });
    // ...and is not turned into a diagram; the diagram is not drawn as a code block.
    await vi.waitFor(() => expect(diagrams()[0]?.querySelector("svg")).toBeTruthy());
    expect(diagrams()[0]?.querySelector("svg")?.getAttribute("data-source")).toBe(
      "graph TD\n  A --> B",
    );
    expect(parent.querySelector(".cm-mint-mermaid .cm-mint-code-language")).toBeNull();
    expect(editor.getText()).toBe(text);
  });

  it("does not change the text: opening and saving keeps the file byte for byte", () => {
    const text = `intro\r\n\r\n\u0060\u0060\u0060mermaid\r\nsequenceDiagram\r\n  A->>B: hi\r\n\u0060\u0060\u0060\r\n`;
    const { editor } = open(text);
    expect(editor.getText()).toBe(text);
  });
});

describe("renderMermaid (for export)", () => {
  it("renders a diagram's source to the SVG the block widget shows", async () => {
    await expect(renderMermaid("graph TD\n  X --> Y")).resolves.toBe(
      '<svg data-source="graph TD\n  X --> Y"></svg>',
    );
  });

  it("rejects with the syntax error", async () => {
    await expect(renderMermaid("an error")).rejects.toThrow("Parse error on line 2: an error");
  });
});

describe("dialect", () => {
  it("keeps mermaid blocks as plain code blocks when the mermaid switch is off", () => {
    const { diagrams, shown } = open(`intro\n\n${flowchart}\n`, {
      dialect: { ...defaultDialect, mermaid: false },
    });
    expect(diagrams()).toEqual([]);
    expect(shown()).toContain("graph TD");
  });
});
