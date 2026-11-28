import { expect, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

test("a writer presents the current draft and returns to the same editing position", async ({
  page,
}) => {
  const path = "/notes/talk.md";
  const source = [
    "# Opening",
    "",
    "A **live** draft.",
    "",
    "```",
    "---",
    "```",
    "",
    "---",
    "",
    "# Closing",
    "",
    ...Array.from({ length: 80 }, (_, i) => `Notes for line ${i}.`),
    "End",
  ].join("\n");
  await launch(page, {
    files: { [path]: source, [settingsPath]: JSON.stringify({ autosave: false }) },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+o");
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  const entry = page.getByRole("button", { name: "Present slides" });
  await expect(entry).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const plugin = settings.getByRole("group", { name: "Slide presentation" });
  await plugin.getByRole("button", { name: "Install", exact: true }).click();
  await settings.getByRole("button", { name: "Deny access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(entry).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Allow access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText(" of draft");
  const draft = `${source} of draft`;
  await editor.press("ArrowLeft");
  const scroller = page.locator(".cm-scroller");
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const top = await scroller.evaluate((el) => el.scrollTop);
  await entry.click();
  const deck = page.getByRole("dialog", { name: "Slide presentation" });
  await expect(deck.getByRole("heading", { name: "Opening" })).toBeVisible();
  await expect(deck.locator("strong")).toHaveText("live");
  await expect(deck.locator("code")).toHaveText("---\n");
  await page.keyboard.press("ArrowRight");
  await expect(deck.getByRole("heading", { name: "Closing" })).toBeVisible();
  await expect(deck).toContainText("End of draft");
  await page.keyboard.press("ArrowLeft");
  await expect(deck.getByRole("heading", { name: "Opening" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top);
  expect(await readFile(page, path)).toBe(source);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(page, path)).toBe(draft);
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Disable" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(entry).toHaveCount(0);
  await editor.press("x");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(page, path)).toBe(`${draft.slice(0, -1)}xt`);
});
