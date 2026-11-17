// The CSS variables are the theme contract (ADR-0003): docs/themes.md lists
// them for theme authors, and the built-in themes give each one a value.
// These checks keep the list, the built-in themes and the code in step.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

/** Every `--mint-*` name in `text`, ignoring names built at run time (`--mint-heading-${n}-size`). */
const names = (text: string, pattern: RegExp) =>
  new Set([...text.matchAll(pattern)].map((m) => m[1] as string));
const nameAt = "(--mint-[a-z0-9-]*[a-z0-9])(?![\\w$-])";

const documented = names(read("docs/themes.md"), new RegExp(`\`${nameAt}\``, "g"));
const builtin = read("apps/desktop/src/theme/builtin.css");
const defined = names(builtin, new RegExp(`${nameAt}\\s*:`, "g"));

function sources(dir: string): string[] {
  return readdirSync(join(repo, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|css)$/.test(e.name) && !/\.test\.ts$/.test(e.name))
    .map((e) => join(e.parentPath, e.name).slice(repo.length + 1));
}
const used = new Set(
  [...sources("packages/editor/src"), ...sources("apps/desktop/src")].flatMap((file) => [
    // `var(--mint-x)` in CSS and TypeScript, `bg-(--mint-x)` in Tailwind classes.
    ...names(read(file), new RegExp(`(?:var\\(\\s*|\\w-\\()${nameAt}`, "g")),
  ]),
);

describe("theme variables", () => {
  it("are all documented, and the documentation lists no others", () => {
    expect([...defined].sort()).toEqual([...documented].sort());
  });

  it("include every variable the editor core and the shell use", () => {
    // Guards against the scan silently finding nothing.
    expect(used).toContain("--mint-find-current");
    expect(used).toContain("--mint-heading-fg");
    expect(used).toContain("--mint-sidebar-bg");
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("include one size per heading level", () => {
    for (let level = 1; level <= 6; level++) {
      expect(defined).toContain(`--mint-heading-${level}-size`);
    }
  });

  it("are given a dark value for every color the light theme sets", () => {
    const light = builtin.slice(0, builtin.indexOf('data-appearance="dark"'));
    const dark = builtin.slice(builtin.indexOf('data-appearance="dark"'));
    const colors = [...light.matchAll(new RegExp(`${nameAt}\\s*:\\s*#`, "g"))].map((m) => m[1]);
    const darkNames = names(dark, new RegExp(`${nameAt}\\s*:`, "g"));
    expect(colors.filter((name) => !darkNames.has(name as string))).toEqual([]);
  });
});
