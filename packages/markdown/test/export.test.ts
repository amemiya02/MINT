// Seam 2: the Markdown package's export interface.
// Feed Markdown + a dialect in, assert on the HTML that comes out.
import { describe, expect, it } from "vitest";
import { type Dialect, defaultDialect, renderHtml } from "../src/index.ts";

describe("defaultDialect", () => {
  it("enables CommonMark/GFM, math, Mermaid and front matter, and no extended syntax (ADR-0004)", () => {
    expect(defaultDialect).toEqual({
      gfm: true,
      math: true,
      mermaid: true,
      frontMatter: true,
      extended: { toc: false, highlight: false, superscript: false, subscript: false },
    });
  });
});

describe("renderHtml", () => {
  it("renders CommonMark headings and emphasis", () => {
    expect(renderHtml("# Title\n\nSome **bold** text.\n", defaultDialect)).toBe(
      "<h1>Title</h1>\n<p>Some <strong>bold</strong> text.</p>",
    );
  });

  it("recognises GFM strikethrough when the dialect enables GFM (the default)", () => {
    expect(renderHtml("~~gone~~\n", defaultDialect)).toBe("<p><del>gone</del></p>");
  });

  it("leaves GFM syntax as plain text when the dialect disables GFM", () => {
    expect(renderHtml("~~gone~~\n", { ...defaultDialect, gfm: false })).toBe("<p>~~gone~~</p>");
  });
});

describe("math", () => {
  const tex = (source: string) => `<annotation encoding="application/x-tex">${source}</annotation>`;

  it("renders $…$ inline math and $$…$$ math blocks with KaTeX", () => {
    const html = renderHtml("Euler: $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x\\,dx\n$$\n", defaultDialect);
    expect(html).toMatch(/^<p>Euler: <span class="katex">.*<\/span><\/p>/s);
    expect(html).toContain('<span class="katex-display">');
    expect(html).toContain(tex("e^{i\\pi}+1=0"));
    expect(html).toContain(tex("\\int_0^1 x\\,dx"));
  });

  it("leaves dollar signs as text when the dialect disables math", () => {
    expect(renderHtml("$x$\n", { ...defaultDialect, math: false })).toBe("<p>$x$</p>");
  });

  it("shows an error for a malformed formula instead of failing the export", () => {
    const html = renderHtml("$\\frac{1}{$ and $y$\n", defaultDialect);
    expect(html).toContain('class="katex-error"');
    expect(html).toContain(tex("y"));
  });
});

describe("extended syntax (ADR-0004)", () => {
  const extended = (switches: Partial<Dialect["extended"]>): Dialect => ({
    ...defaultDialect,
    extended: { ...defaultDialect.extended, ...switches },
  });

  it("leaves every extended syntax as plain text by default", () => {
    expect(renderHtml("==a== ^b^ ~c~\n\n[TOC]\n", defaultDialect)).toBe(
      "<p>==a== ^b^ ~c~</p>\n<p>[TOC]</p>",
    );
  });

  it("renders ==highlight== as <mark>, with inline Markdown inside, when enabled", () => {
    expect(renderHtml("A ==very **big**== deal\n", extended({ highlight: true }))).toBe(
      "<p>A <mark>very <strong>big</strong></mark> deal</p>",
    );
  });

  it("renders ^superscript^ as <sup> when enabled; spaces end it, backslash escapes stay escapes", () => {
    expect(renderHtml("x^2^ and 2^10\\^3^ and a^b c^\n", extended({ superscript: true }))).toBe(
      "<p>x<sup>2</sup> and 2<sup>10^3</sup> and a^b c^</p>",
    );
  });

  it("renders ~subscript~ as <sub> when enabled, next to ~~strikethrough~~", () => {
    expect(renderHtml("H~2~O is ~~not~~ water~ ~\n", extended({ subscript: true }))).toBe(
      "<p>H<sub>2</sub>O is <del>not</del> water~ ~</p>",
    );
  });

  it("renders a [TOC] line as a nested list linking to the document's headings when enabled", () => {
    const html = renderHtml(
      "# Guide\n\n[TOC]\n\n## Set *up*\n\n### Install\n\n## Set up\n\n# Notes\n",
      extended({ toc: true }),
    );
    // Ids are prefixed so they cannot clobber globals in the app; the links follow them.
    expect(html).toBe(
      [
        '<h1 id="user-content-guide">Guide</h1>',
        '<nav class="toc"><ul><li><a href="#user-content-guide">Guide</a><ul>' +
          '<li><a href="#user-content-set-up">Set up</a><ul><li><a href="#user-content-install">Install</a></li></ul></li>' +
          '<li><a href="#user-content-set-up-1">Set up</a></li></ul></li>' +
          '<li><a href="#user-content-notes">Notes</a></li></ul></nav>',
        '<h2 id="user-content-set-up">Set <em>up</em></h2>',
        '<h3 id="user-content-install">Install</h3>',
        '<h2 id="user-content-set-up-1">Set up</h2>',
        '<h1 id="user-content-notes">Notes</h1>',
      ].join("\n"),
    );
  });

  it("recognises [TOC] only alone on its line, not inside a paragraph", () => {
    expect(renderHtml("text\n[TOC]\n\n[TOC] here\n\n  [TOC]  \n", extended({ toc: true }))).toBe(
      '<p>text\n[TOC]</p>\n<p>[TOC] here</p>\n<nav class="toc"></nav>',
    );
  });

  it("enables each extended syntax on its own", () => {
    expect(renderHtml("==a== ^b^ ~c~\n", extended({ superscript: true }))).toBe(
      "<p>==a== <sup>b</sup> ~c~</p>",
    );
  });
});

describe("front matter", () => {
  const post = "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n";

  it("leaves a leading YAML front matter block out of the HTML", () => {
    expect(renderHtml(post, defaultDialect)).toBe("<h1>Body</h1>");
  });

  it("recognises front matter only at the very start of the document", () => {
    expect(renderHtml(`Intro\n\n${post}`, defaultDialect)).toBe(
      "<p>Intro</p>\n<hr>\n<h2>title: Hello\ntags: [a, b]</h2>\n<h1>Body</h1>",
    );
  });

  it("treats the block as a rule and a heading when the dialect disables front matter", () => {
    expect(renderHtml(post, { ...defaultDialect, frontMatter: false })).toBe(
      "<hr>\n<h2>title: Hello\ntags: [a, b]</h2>\n<h1>Body</h1>",
    );
  });
});

describe("untrusted HTML (rendered into the app)", () => {
  const render = (markdown: string) => renderHtml(markdown, defaultDialect);

  it("keeps harmless inline HTML such as a line break in a table cell", () => {
    expect(render("| a |\n| - |\n| one<br>two |\n")).toContain("one<br>two");
  });

  it("drops scripts, event handlers and javascript: URLs", () => {
    const html = render(
      [
        "<script>alert(1)</script>",
        '<img src=x onerror="alert(2)">',
        "[link](javascript:alert(3))",
        '<a href="javascript:alert(4)">raw</a>',
        '<iframe src="https://example.com"></iframe>',
        "<svg><script>alert(5)</script></svg>",
        '<div style="position:fixed" onclick="alert(6)">x</div>',
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:|<iframe|alert\(\d\)<\/script/i);
    expect(html).toContain("link");
  });

  it("keeps what MINT renders itself: math, highlights, sub/superscript, code classes, task lists, footnotes", () => {
    const html = renderHtml(
      "$x^2$ ==hi== ^up^ ~down~\n\n- [x] done\n\n```js\nlet a\n```\n\nNote[^1]\n\n[^1]: Footnote.\n",
      {
        ...defaultDialect,
        extended: { toc: false, highlight: true, superscript: true, subscript: true },
      },
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain("<math");
    expect(html).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
    expect(html).toMatch(/<span class="[^"]*mord[^"]*"/);
    expect(html).toContain("<mark>hi</mark>");
    expect(html).toContain("<sup>up</sup>");
    expect(html).toContain("<sub>down</sub>");
    expect(html).toMatch(
      /<input type="checkbox" checked disabled>|<input checked disabled type="checkbox">|<input type="checkbox" disabled checked>/,
    );
    expect(html).toContain('class="language-js"');
    expect(html).toMatch(/<a href="#user-content-fn-1" id="user-content-fnref-1"/);
    expect(html).toMatch(/<li id="user-content-fn-1">/);
  });
});
