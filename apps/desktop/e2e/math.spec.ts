import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

test("formulas render with KaTeX and expand into their source when clicked", async ({ page }) => {
  const path = "/notes/math.md";
  const text = "Area $\\pi r^2$ here\n\n$$\nE = mc^2\n$$\n\nBroken $\\frac{1}{$ formula\n";
  await launch(page, { files: { [path]: text }, openDialogResults: [path], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");

  const inline = page.locator(".cm-mint-math-inline").first();
  const block = page.locator(".cm-mint-math-block");
  await expect(inline.locator(".katex-html")).toBeVisible();
  await expect(block.locator(".katex-display")).toBeVisible();
  // KaTeX's stylesheet is loaded: formulas are set in KaTeX's fonts.
  await expect(inline.locator(".katex")).toHaveCSS("font-family", /KaTeX_Main/);
  await expect(page.locator(".cm-mint-math-error")).toContainText("KaTeX parse error");
  await expect(page.locator(".cm-line", { hasText: "E = mc^2" })).toHaveCount(0);

  await block.click();
  await expect(page.locator(".cm-line", { hasText: "E = mc^2" })).toBeVisible();
  await expect(block).toHaveCount(0);

  await inline.click();
  await expect(page.locator(".cm-line").first()).toHaveText("Area $\\pi r^2$ here");
  await expect(block.locator(".katex-display")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+End");
  await expect(inline.locator(".katex-html")).toBeVisible();
  await expect(page.locator(".cm-line").first()).not.toContainText("$");

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(text);
});
