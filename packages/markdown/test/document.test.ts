// Seam 2: the Markdown package's export interface, for the standalone HTML
// document. Feed Markdown + options in, inspect the document that comes out
// (parsed with a DOM parser, as a browser opening the exported file would).
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { defaultDialect, type ExportOptions, exportHtml } from "../src/index.ts";

const theme = ":root { --mint-bg: #fbf8f1; }";
const base: ExportOptions = { dialect: defaultDialect, themeCss: theme, appearance: "light" };

async function exported(markdown: string, options: Partial<ExportOptions> = {}) {
  const html = await exportHtml(markdown, { ...base, ...options });
  return { html, doc: new DOMParser().parseFromString(html, "text/html") };
}

/** Every URL the document would load (stylesheets, scripts, images, fonts, frames). */
function loadedUrls(html: string, doc: Document): string[] {
  const attrs = [...doc.querySelectorAll("[src], link[href], object[data]")].map(
    (el) => el.getAttribute("src") ?? el.getAttribute("href") ?? el.getAttribute("data") ?? "",
  );
  const cssUrls = [...html.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1] ?? "");
  const imports = [...html.matchAll(/@import\s+['"]?([^'";\s]+)/g)].map((m) => m[1] ?? "");
  return [...attrs, ...cssUrls, ...imports];
}

describe("exportHtml", () => {
  it("produces a complete HTML document with the rendered Markdown in its body", async () => {
    const { html, doc } = await exported("# Notes\n\nSome **bold** text.\n");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(doc.querySelector('meta[charset="utf-8"]')).not.toBeNull();
    expect(doc.querySelector("body h1")?.textContent).toBe("Notes");
    expect(doc.querySelector("body p strong")?.textContent).toBe("bold");
  });

  it("titles the document after its first heading, or else as asked", async () => {
    expect(
      (await exported("intro\n\n## First *heading*\n\n# Later\n", { title: "file" })).doc.title,
    ).toBe("First heading");
    expect((await exported("no heading\n", { title: "My <file>" })).doc.title).toBe("My <file>");
    expect((await exported("no heading\n")).doc.title).toBe("");
  });

  it("inlines the theme and applies the chosen appearance", async () => {
    const { doc } = await exported("text\n", { appearance: "dark" });
    expect(doc.documentElement.dataset.appearance).toBe("dark");
    const styles = [...doc.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(styles).toContain(theme);
    // Document styles are written against the theme variables.
    expect(styles).toContain("var(--mint-bg");
  });

  it("does not render a YAML front matter block", async () => {
    const { doc } = await exported("---\ntitle: Hello\n---\n\n# Body\n");
    expect(doc.body.textContent).not.toContain("title: Hello");
    expect(doc.querySelector("hr")).toBeNull();
    expect(doc.querySelector("h1")?.textContent).toBe("Body");
  });

  it("leaves a front matter block as Markdown when the dialect disables it", async () => {
    const { doc } = await exported("---\nx\n---\n", {
      dialect: { ...defaultDialect, frontMatter: false },
    });
    expect(doc.querySelector("hr")).not.toBeNull();
  });
});

describe("math", () => {
  it("embeds KaTeX's stylesheet and fonts when the document has math", async () => {
    const { html, doc } = await exported("Euler: $e^{i\\pi}+1=0$\n");
    expect(doc.querySelector(".katex")).not.toBeNull();
    expect(html).toContain(".katex{");
    const fonts = [...html.matchAll(/@font-face\{[^}]*\}/g)].map((m) => m[0]);
    expect(fonts.length).toBe(20);
    for (const font of fonts) expect(font).toMatch(/src:url\(data:font\/woff2;base64,[^)]+\)/);
    expect(loadedUrls(html, doc).filter((url) => !url.startsWith("data:"))).toEqual([]);
  });

  it("leaves KaTeX out of documents without math", async () => {
    const { html } = await exported("No formulas, $5 only.\n");
    expect(html).not.toContain("@font-face");
  });
});

describe("code blocks", () => {
  it("highlights code with the editor's token classes and labels the language", async () => {
    const { doc } = await exported("```js\nconst n = 1; // one\n```\n");
    const pre = doc.querySelector("pre");
    expect(pre?.dataset.language).toBe("js");
    expect(pre?.textContent).toBe("const n = 1; // one\n");
    const token = (cls: string) =>
      [...(pre?.querySelectorAll(`.${cls}`) ?? [])].map((el) => el.textContent);
    expect(token("cm-mint-code-keyword")).toEqual(["const"]);
    expect(token("cm-mint-code-number")).toEqual(["1"]);
    expect(token("cm-mint-code-comment")).toEqual(["// one"]);
    // Token colors come from the theme variables, as in the editor.
    const styles = [...doc.querySelectorAll("style")].map((s) => s.textContent).join("\n");
    expect(styles).toMatch(/\.cm-mint-code-keyword \{[^}]*var\(--mint-accent/);
  });

  it("keeps code of an unknown or missing language plain", async () => {
    const { doc } = await exported("```nosuchlang\nif x\n```\n\n```\nif y\n```\n");
    const blocks = [...doc.querySelectorAll("pre")];
    expect(blocks.map((b) => b.textContent)).toEqual(["if x\n", "if y\n"]);
    expect(doc.querySelectorAll("pre span")).toHaveLength(0);
    expect(blocks[1]?.dataset.language).toBeUndefined();
  });
});

describe("mermaid diagrams", () => {
  const flowchart = "```mermaid\ngraph TD\n  A --> B\n```\n";
  const renderMermaid = async (source: string) => {
    if (source.includes("error")) throw new Error("Parse error on line 2");
    return `<svg xmlns="http://www.w3.org/2000/svg" data-source="${source}"><text>A</text></svg>`;
  };

  it("embeds each diagram as the SVG it renders to", async () => {
    const { doc } = await exported(flowchart, { renderMermaid });
    expect(doc.querySelector("pre")).toBeNull();
    expect(doc.querySelector("figure.mint-mermaid svg")?.getAttribute("data-source")).toBe(
      "graph TD\n  A --> B",
    );
  });

  it("shows the syntax error of a diagram that does not render", async () => {
    const { doc } = await exported("```mermaid\nan error\n```\n", { renderMermaid });
    expect(doc.querySelector("svg")).toBeNull();
    expect(doc.querySelector(".mint-mermaid-error")?.textContent).toBe(
      "Mermaid: Parse error on line 2",
    );
  });

  it("keeps diagrams as code when the dialect disables Mermaid", async () => {
    const { doc } = await exported(flowchart, {
      renderMermaid,
      dialect: { ...defaultDialect, mermaid: false },
    });
    expect(doc.querySelector("svg")).toBeNull();
    expect(doc.querySelector("pre code")?.textContent).toBe("graph TD\n  A --> B\n");
  });
});

describe("images", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const loadImage = async (src: string) =>
    src === "assets/shot.png" ? { data: png, type: "image/png" } : null;

  it("embeds the images it can load as data URIs", async () => {
    const { doc } = await exported("![shot](assets/shot.png)\n", { loadImage });
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    expect(doc.querySelector("img")?.getAttribute("alt")).toBe("shot");
  });

  it("keeps references it cannot embed, and all references when not embedding", async () => {
    const markdown = "![a](assets/shot.png) ![b](https://example.com/b.png) ![c](gone.png)\n";
    const failing = async (src: string) => {
      if (src === "gone.png") throw new Error("missing");
      return loadImage(src);
    };
    const sources = (doc: Document) =>
      [...doc.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources((await exported(markdown, { loadImage: failing })).doc)).toEqual([
      "data:image/png;base64,iVBORw==",
      "https://example.com/b.png",
      "gone.png",
    ]);
    expect(sources((await exported(markdown)).doc)).toEqual([
      "assets/shot.png",
      "https://example.com/b.png",
      "gone.png",
    ]);
  });
});

describe("offline", () => {
  it("loads nothing from outside the file when images are embedded", async () => {
    const markdown = [
      "---",
      "title: All of it",
      "---",
      "# Everything",
      "",
      "Text with $x^2$, `code`, ~~strike~~ and a [link](https://example.com)[^1].",
      "",
      "$$\n\\sum_{i=1}^n i\n$$",
      "",
      "| a | b |\n|---|:-:|\n| 1 | 2 |",
      "",
      "- [x] done\n- [ ] todo",
      "",
      "```python\ndef f(): return 'x'\n```",
      "",
      "```mermaid\ngraph TD\n  A --> B\n```",
      "",
      "![shot](assets/shot.png)",
      "",
      "[^1]: A footnote.",
      "",
    ].join("\n");
    const { html, doc } = await exported(markdown, {
      renderMermaid: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      loadImage: async () => ({ data: new Uint8Array([1, 2, 3]), type: "image/png" }),
    });
    expect(doc.querySelectorAll("script")).toHaveLength(0);
    expect(loadedUrls(html, doc).filter((url) => !url.startsWith("data:"))).toEqual([]);
  });
});

describe("HTML written in the document", () => {
  it("is kept as written", async () => {
    const { doc } = await exported(
      "<details><summary>More</summary>\n\nHidden <kbd>⌘</kbd>\n\n</details>\n",
    );
    expect(doc.querySelector("details summary")?.textContent).toBe("More");
    expect(doc.querySelector("details kbd")?.textContent).toBe("⌘");
  });

  it("loses whatever would run code when the file is opened", async () => {
    const { html, doc } = await exported(
      [
        "<script>alert(1)</script>",
        '<img src="a.png" onerror="alert(2)" alt="pic">',
        "[link](javascript:alert(3))",
        '<a href=" java\tscript:alert(4)">raw</a>',
        '<div onclick="alert(5)">box</div>',
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:|java\tscript/i);
    expect(doc.querySelector("img")?.getAttribute("alt")).toBe("pic");
    expect(doc.querySelector("div")?.textContent).toBe("box");
    expect([...doc.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["link", "raw"]);
  });
});
