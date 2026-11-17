// Seam 2: the Markdown package's export interface.
// Feed Markdown + a dialect in, assert on the HTML that comes out.
import { describe, expect, it } from "vitest";
import { defaultDialect, renderHtml } from "../src/index.ts";

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
