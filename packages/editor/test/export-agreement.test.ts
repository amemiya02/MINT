// The editor core and the exported HTML document are both derived from the one
// dialect definition. The same samples go through the editor's public
// interface and through `exportHtml`; both must recognise the same syntax.
import { type Dialect, defaultDialect, exportHtml } from "@mint/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, type MintEditor } from "../src/index.ts";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => ({
      svg: `<svg data-source="${source.trim()}"></svg>`,
    })),
  },
}));

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, dialect: Dialect) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, dialect });
  mounted.push({ editor, parent });
  // The cursor at the very start, on a line of its own, so every block below renders.
  editor.setSelection({ anchor: 0 });
  return { editor, parent };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

async function exported(text: string, dialect: Dialect) {
  const html = await exportHtml(text, {
    dialect,
    themeCss: "",
    appearance: "light",
    renderMermaid: async (source) => `<svg data-source="${source.trim()}"></svg>`,
  });
  return new DOMParser().parseFromString(html, "text/html");
}

const headingSamples = [
  "# Atx\n\n## Second *emphasis* and `code`\n",
  "Setext\n======\n\nOther\n------\n",
  "#NoSpace\n\n####### seven\n\n\\# escaped\n",
  "> # In a quote\n\n- ## In a list\n",
  "    # indented code\n",
  "```\n# in fenced code\n```\n",
  "# Closing hashes ##\n",
  "~~~\n# tilde fence\n~~~\n\n# After\n",
];

describe("editor and export agree on what is a heading", () => {
  it.each(headingSamples)("%j", async (sample) => {
    const text = `start\n\n${sample}`;
    const { editor } = open(text, defaultDialect);
    const doc = await exported(text, defaultDialect);
    const exportedHeadings = [...doc.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => ({
      level: Number(h.tagName.slice(1)),
      text: h.textContent?.replace(/\s+/g, " ").trim(),
    }));
    await vi.waitFor(() =>
      expect(editor.getOutline().map(({ level, text }) => ({ level, text }))).toEqual(
        exportedHeadings,
      ),
    );
  });
});

describe("editor and export agree on what is a Mermaid diagram", () => {
  const samples = [
    "```mermaid\ngraph TD\n  A --> B\n```\n",
    "```Mermaid\ngraph LR\n  C --> D\n```\n",
    "```mermaid extra\ngraph TD\n  E --> F\n```\n",
    "```\ngraph TD\n```\n\n```js\nlet x\n```\n",
    "~~~mermaid\ngraph TD\n  G --> H\n~~~\n",
  ];

  for (const dialect of [defaultDialect, { ...defaultDialect, mermaid: false }]) {
    it.each(samples)(`mermaid ${dialect.mermaid ? "on" : "off"}: %j`, async (sample) => {
      const text = `start\n\n${sample}`;
      const { parent } = open(text, dialect);
      const doc = await exported(text, dialect);
      const expected = [...doc.querySelectorAll("figure.mint-mermaid svg")].map((svg) =>
        svg.getAttribute("data-source"),
      );
      await vi.waitFor(() =>
        expect(
          [...parent.querySelectorAll(".cm-mint-mermaid svg")].map((svg) =>
            svg.getAttribute("data-source"),
          ),
        ).toEqual(expected),
      );
    });
  }
});

describe("editor and export highlight code alike", () => {
  const samples = [
    ["js", "const n = 1; // one\nfunction f() { return 'x'; }"],
    ["python", "def f(n):\n    return n + 1  # inc\n"],
    ["rust", 'fn main() {\n    let x = 5; // five\n    println!("{}", x);\n}'],
  ] as const;

  /** Each highlighted token as `class:text`, in document order. */
  const tokens = (root: ParentNode) =>
    [...root.querySelectorAll("[class*='cm-mint-code-']")]
      .filter((el) => !el.className.includes("cm-mint-code-language"))
      .map((el) => `${el.className.match(/cm-mint-code-\w+/)?.[0]}:${el.textContent}`);

  it.each(samples)("%s", async (language, code) => {
    const text = `start\n\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    const { parent } = open(text, defaultDialect);
    const doc = await exported(text, defaultDialect);
    const expected = tokens(doc.body);
    expect(expected.length).toBeGreaterThan(2);
    await vi.waitFor(() => expect(tokens(parent)).toEqual(expected), { timeout: 10_000 });
  });
});
