import { expect, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

test("review rewrites in either pane and reopen the chosen wording", async ({ page }) => {
  const path = "/notes/draft.md";
  const original = "\uFEFFcat and dog  \r\n\r\n# Untouched\nLast\r";
  await launch(page, {
    files: { [path]: original, [settingsPath]: '{"autosave":false}' },
    openDialogResults: [path, path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("button", { name: "Track changes" }).click({ timeout: 3000 });
  const editors = page.getByRole("textbox");
  await editors.first().focus();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.type("fox");
  await page.getByRole("button", { name: "Open draft.md in other pane" }).click();
  await editors.last().focus();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.type("owl");
  const review = page.getByRole("region", { name: "Tracked changes" });
  await expect(review.locator("del")).toHaveText(["cat", "dog"]);
  await expect(review.locator("ins")).toHaveText(["fox", "owl"]);
  await review.getByRole("button", { name: "Accept" }).first().click();
  await review.getByRole("button", { name: "Reject" }).click();
  await expect(editors.first()).toContainText("fox and dog");
  await page.getByRole("button", { name: "Stop tracking" }).click();
  await expect(review).toHaveCount(0);
  await editors.last().focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Done");
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe("\uFEFFfox and dog  \r\n\r\n# Untouched\nLast\rDone");
  await page.keyboard.press("ControlOrMeta+W");
  await editors.first().focus();
  await page.keyboard.press("ControlOrMeta+W");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(editors.first()).toContainText("fox and dog");
  await expect(editors.first()).toContainText("Done");
});

test("locate identical rewrites and reject the one in the second paragraph", async ({ page }) => {
  const path = "/notes/repeated.md";
  await launch(page, {
    files: { [path]: "\uFEFFOne\r\n\nOne", [settingsPath]: '{"autosave":false}' },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("button", { name: "Track changes" }).click();
  for (const key of ["ControlOrMeta+Home", "ControlOrMeta+End"]) {
    await page.keyboard.press(key);
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.type("Two");
  }
  const review = page.getByRole("region", { name: "Tracked changes" });
  await review.getByRole("button", { name: "Line 3, column 1" }).click({ timeout: 3000 });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("Two");
  await review.getByRole("button", { name: "Reject" }).last().click();
  await expect(review.locator("ins")).toHaveText(["Two"]);
  await page.getByRole("button", { name: "Keep remaining changes and stop tracking" }).click();
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe("\uFEFFTwo\r\n\nOne");
});

test("rejecting a deletion inside repeated letters clears the reviewed occurrence", async ({
  page,
}) => {
  const path = "/notes/letters.md";
  await launch(page, { files: { [path]: "aaaa" }, openDialogResults: [path], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("button", { name: "Track changes" }).click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Delete");
  const review = page.getByRole("region", { name: "Tracked changes" });
  await review.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByRole("textbox")).toHaveText("aaaa");
  await expect(review.getByText("No pending changes")).toBeVisible();
});
