// Seam 2: the Markdown package's export interface, in the other direction.
// Feed HTML (as found on the clipboard) + a dialect in, assert on the Markdown that comes out.
import { describe, expect, it } from "vitest";
import { defaultDialect, htmlToMarkdown } from "../src/index.ts";

const md = (html: string) => htmlToMarkdown(html, defaultDialect);

describe("htmlToMarkdown", () => {
  it("converts headings, paragraphs and inline formatting", () => {
    expect(
      md(
        "<h1>Title</h1><p>Some <b>bold</b>, <em>italic</em> and <code>code</code>.</p><h3>Sub</h3>",
      ),
    ).toBe("# Title\n\nSome **bold**, *italic* and `code`.\n\n### Sub\n");
  });

  it("converts links and images", () => {
    expect(
      md(
        '<p>See <a href="https://example.com/a" title="T">the site</a> <img src="x.png" alt="X"></p>',
      ),
    ).toBe('See [the site](https://example.com/a "T") ![X](x.png)\n');
  });

  it("converts bullet, ordered and nested lists", () => {
    expect(md("<ul><li>one</li><li>two<ol><li>a</li><li>b</li></ol></li></ul>")).toBe(
      "- one\n- two\n  1. a\n  2. b\n",
    );
  });

  it("converts code blocks to fenced code with their language", () => {
    expect(md('<pre><code class="language-js">const a = 1;\nconsole.log(a);\n</code></pre>')).toBe(
      "```js\nconst a = 1;\nconsole.log(a);\n```\n",
    );
  });

  it("converts block quotes and rules", () => {
    expect(md("<blockquote><p>quoted</p></blockquote><hr><p>after</p>")).toBe(
      "> quoted\n\n---\n\nafter\n",
    );
  });

  it("escapes text that would otherwise be read as Markdown", () => {
    expect(md("<p>2 * 3 * 4 and [not a link]</p>")).toBe("2 \\* 3 \\* 4 and \\[not a link]\n");
  });

  it("ignores metadata, styles and scripts on the clipboard", () => {
    expect(
      md('<meta charset="utf-8"><style>p{color:red}</style><script>alert(1)</script><p>Text</p>'),
    ).toBe("Text\n");
  });
});

describe("GFM", () => {
  const table =
    "<table><thead><tr><th>Name</th><th align='right'>Qty</th></tr></thead>" +
    "<tbody><tr><td>Apple</td><td align='right'>3</td></tr><tr><td>Pear | x</td><td align='right'>10</td></tr></tbody></table>";

  it("converts tables to GFM tables when the dialect enables GFM", () => {
    expect(md(table)).toBe(
      "| Name      | Qty |\n| --------- | --: |\n| Apple     |   3 |\n| Pear \\| x |  10 |\n",
    );
  });

  it("converts strikethrough and task lists", () => {
    expect(
      md(
        '<p><del>gone</del></p><ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>',
      ),
    ).toBe("~~gone~~\n\n- [x] done\n- [ ] todo\n");
  });

  it("keeps a table as HTML and drops strikethrough when the dialect disables GFM", () => {
    const noGfm = { ...defaultDialect, gfm: false };
    expect(htmlToMarkdown("<p><del>gone</del></p>", noGfm)).toBe("gone\n");
    const result = htmlToMarkdown(table, noGfm);
    expect(result).toMatch(/^<table>/);
    expect(result).toContain("<td>Apple</td>");
    expect(result).not.toContain("| --");
  });
});

describe("math", () => {
  // What KaTeX renders (e.g. copied from MINT's own export): the TeX source is in an annotation.
  const katex = (tex: string, display: boolean) => {
    const inner = `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">rendered</span></span></span>`;
    return display ? `<span class="katex-display">${inner}</span>` : inner;
  };

  it("turns rendered formulas back into $…$ and $$…$$ when the dialect enables math", () => {
    expect(
      md(`<p>Euler: ${katex("e^{i\\pi}+1=0", false)} holds.</p>${katex("\\int_0^1 x", true)}`),
    ).toBe("Euler: $e^{i\\pi}+1=0$ holds.\n\n$$\n\\int_0^1 x\n$$\n");
  });

  it("keeps the TeX source as plain text when the dialect disables math", () => {
    expect(
      htmlToMarkdown(`<p>${katex("x^2", false)}</p>`, { ...defaultDialect, math: false }),
    ).toBe("x^2\n");
  });
});

describe("extended syntax", () => {
  const html = "<p><mark>hi</mark> x<sup>2</sup> H<sub>2</sub>O</p>";

  it("keeps only the text of highlight, superscript and subscript by default (ADR-0004)", () => {
    expect(md(html)).toBe("hi x2 H2O\n");
  });

  it("writes ==…==, ^…^ and ~…~ when the dialect enables them", () => {
    const extended = {
      ...defaultDialect,
      extended: { toc: false, highlight: true, superscript: true, subscript: true },
    };
    expect(htmlToMarkdown(html, extended)).toBe("==hi== x^2^ H~2~O\n");
  });
});

describe("messy clipboard HTML", () => {
  it("does not read the Google Docs wrapper as bold", () => {
    expect(
      md(
        '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-123"><p dir="ltr"><span style="font-weight:700">Bold</span> plain</p></b>',
      ),
    ).toBe("**Bold** plain\n");
  });

  it("reads styled spans as emphasis and drops the trailing Apple newline", () => {
    expect(
      md(
        '<span style="font-style:italic">it</span> and <span style="text-decoration:line-through">gone</span><br class="Apple-interchange-newline">',
      ),
    ).toBe("*it* and ~~gone~~\n");
  });

  it("gives an empty string for HTML without content", () => {
    expect(md("<meta charset='utf-8'><style></style>")).toBe("");
  });
});
