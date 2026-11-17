// Seam 2: the Markdown package's export interface.
// Feed Markdown + a dialect in, assert on the HTML that comes out.
import { describe, expect, it } from "vitest";
import { defaultDialect, renderHtml } from "../src/index.ts";

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
