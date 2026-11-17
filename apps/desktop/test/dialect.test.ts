// The extended syntax settings are the dialect's switches: the dialect the
// shell hands to the editor is the one the export pipeline renders with.
import { defaultDialect, renderHtml } from "@mint/markdown";
import { describe, expect, it } from "vitest";
import { dialectOf } from "../src/settings/dialect.ts";

/** The extended syntax settings as they are by default. */
const defaultSettings = {
  extendedToc: false,
  extendedHighlight: false,
  extendedSuperscript: false,
  extendedSubscript: false,
};

describe("dialectOf", () => {
  it("is the default dialect for the default settings", () => {
    expect(dialectOf(defaultSettings)).toEqual(defaultDialect);
  });

  it.each([
    ["extendedToc", "[TOC]\n\n# A\n", '<nav class="toc">'],
    ["extendedHighlight", "==a==\n", "<mark>a</mark>"],
    ["extendedSuperscript", "^a^\n", "<sup>a</sup>"],
    ["extendedSubscript", "~a~\n", "<sub>a</sub>"],
  ] as const)("switches %s on in the export too", (setting, markdown, html) => {
    expect(renderHtml(markdown, dialectOf(defaultSettings))).not.toContain(html);
    expect(renderHtml(markdown, dialectOf({ ...defaultSettings, [setting]: true }))).toContain(
      html,
    );
  });
});
