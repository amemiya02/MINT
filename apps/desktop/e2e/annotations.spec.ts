import { expect, test } from "@playwright/test";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

test("annotate the selected occurrence and keep its excerpt when it is deleted", async ({
  page,
}) => {
  const path = "/notes/draft.md";
  const original = "\uFEFFRepeated sentence.\r\n\r\nRepeated sentence.  \n";
  await launch(page, {
    files: { [path]: original, [settingsPath]: '{"autosave":false}' },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("textbox").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+End");
  await page.getByRole("button", { name: "Add annotation" }).click();
  await page.getByRole("textbox", { name: "Annotation" }).fill("Check the second sentence.");
  await page.getByRole("button", { name: "Save annotation" }).click();

  const annotations = page.getByRole("complementary", { name: "Annotations" });
  const pending = annotations.getByRole("region", { name: "Pending" });
  await expect(pending).toContainText("Check the second sentence.");
  await expect(pending.getByRole("blockquote")).toHaveText("Repeated sentence.");
  await page.getByRole("button", { name: "Open draft.md in other pane" }).click();
  await page.getByRole("textbox").last().focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Enter");
  await pending.getByRole("button", { name: "Go to target" }).click();
  await expect
    .poll(() => page.evaluate(() => getSelection()?.anchorNode?.parentElement?.textContent))
    .toBe("Repeated sentence.  ");
  await page.keyboard.press("Backspace");
  const lost = annotations.getByRole("region", { name: "Lost position" });
  await expect(lost.getByRole("blockquote")).toHaveText("Repeated sentence.");
  await expect(lost).toContainText("Check the second sentence.");
  await expect(lost.getByRole("button", { name: "Go to target" })).toHaveCount(0);
  expect(await readFile(page, path)).toBe(original);
});

test("reopening a saved document restores the annotation and its decision", async ({ page }) => {
  const path = "/notes/review.md";
  const original = "Field notes.\r\n";
  await launch(page, {
    files: { [path]: original, [settingsPath]: '{"autosave":false}' },
    openDialogResults: [path, path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("textbox").focus();
  await page.keyboard.press("Shift+End");
  await runMenuItem(page, "edit.addAnnotation");
  await page.getByRole("textbox", { name: "Annotation" }).fill("Check wording.");
  await page.getByRole("button", { name: "Save annotation" }).click();
  await page.getByRole("button", { name: "Mark resolved" }).click();
  await page.keyboard.press("ControlOrMeta+W");
  await page.keyboard.press("ControlOrMeta+O");

  const resolved = page.getByRole("region", { name: "Resolved" });
  await expect(resolved).toContainText("Check wording.");
  await resolved.getByRole("button", { name: "Go to target" }).click();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("Field notes.");
  await resolved.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByRole("region", { name: "Pending" })).toContainText("Check wording.");
  expect(await readFile(page, path)).toBe(original);
});

test("annotate and revisit a table cell, a formula, and an image from Live Preview", async ({
  page,
}) => {
  const path = "/notes/figures.md";
  const original =
    "# Draft\n\n| Value | Note |\n| --- | --- |\n| 10 | measured |\n\nArea $x^2$ here.\n\n![Chart](missing.png)\n";
  await launch(page, {
    files: { [path]: original, [settingsPath]: '{"autosave":false}' },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");

  const cell = page.getByRole("cell", { name: "10", exact: true });
  await cell.click();
  await page.keyboard.press("ControlOrMeta+Alt+M");
  const dialog = page.getByRole("dialog", { name: "Add annotation" });
  const save = async (excerpt: string, note: string) => {
    await expect(dialog.getByRole("blockquote")).toHaveText(excerpt);
    await dialog.getByRole("textbox", { name: "Annotation" }).fill(note);
    await dialog.getByRole("button", { name: "Save annotation" }).click();
  };
  await save("10", "Verify the measurement.");

  await page.locator(".cm-mint-math-inline").click();
  await page.getByRole("button", { name: "Add annotation" }).click();
  await save("$x^2$", "Define x.");

  await page.getByRole("img", { name: "Chart" }).click();
  await page.getByRole("button", { name: "Add annotation" }).click();
  await save("![Chart](missing.png)", "Replace the chart.");

  const panel = page.getByRole("complementary", { name: "Annotations" });
  const pending = panel.getByRole("region", { name: "Pending" });
  const resolved = panel.getByRole("region", { name: "Resolved" });
  const lost = panel.getByRole("region", { name: "Lost position" });
  const item = (note: string) => pending.getByRole("listitem").filter({ hasText: note });
  await item("Replace the chart.").getByRole("button", { name: "Go to target" }).click();
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString()))
    .toBe("![Chart](missing.png)");
  await item("Define x.").getByRole("button", { name: "Go to target" }).click();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("$x^2$");
  await item("Define x.").getByRole("button", { name: "Mark resolved" }).click();
  await expect(resolved).toContainText("Define x.");

  await item("Verify the measurement.").getByRole("button", { name: "Go to target" }).click();
  await expect(cell.locator("[contenteditable]")).toBeFocused();
  await page.getByRole("button", { name: "Format table" }).click();
  await expect(item("Verify the measurement.").getByRole("blockquote")).toHaveText("10");
  await page.getByRole("button", { name: "Delete row" }).click();
  await expect(lost).toContainText("Verify the measurement.");
  await expect(lost.getByRole("blockquote")).toHaveText("10");
  expect(await readFile(page, path)).toBe(original);
});
