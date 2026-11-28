import { expect, test } from "@playwright/test";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import {
  externalWrite,
  files,
  launch,
  readFile,
  runMenuItem,
  settingsPath,
} from "./memory-platform.ts";

test("reopen a saved document and compare any two versions without changing the draft", async ({
  page,
  browser,
}) => {
  const path = "/notes/report.md";
  await launch(page, {
    files: { [path]: "", [settingsPath]: '{"autosave":false}' },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const editor = page.getByRole("textbox");
  for (const body of ["First draft", "Second draft", "Final draft"]) {
    await editor.fill(body);
    await page.keyboard.press("ControlOrMeta+S");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect.poll(() => readFile(page, path)).toBe(body);
  }
  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.getByText("No document open")).toBeVisible();
  const disk = await files(page);
  expect(Object.keys(disk).filter((p) => p.startsWith("/notes/"))).toEqual([path]);
  const appData = await page.evaluate(() =>
    Object.fromEntries(
      (window as unknown as { __MINT_MEMORY_PLATFORM__: MemoryPlatform }).__MINT_MEMORY_PLATFORM__
        .appData,
    ),
  );
  await page.close();
  const next = await browser.newPage();
  await launch(next, { files: disk, appData, openDialogResults: [path], locale: "en-US" });
  await next.keyboard.press("ControlOrMeta+O");
  await next.getByRole("textbox").fill("Unpublished draft");
  await runMenuItem(next, "file.history");
  const dialog = next.getByRole("dialog", { name: "Version History" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("From version").selectOption({ index: 0 });
  await dialog.getByLabel("To version").selectOption({ index: 2 });
  await expect(dialog.locator("del")).toContainText("First draft");
  await expect(dialog.locator("ins")).toContainText("Final draft");
  await expect(dialog).not.toContainText("Second draft");
  await next.keyboard.press("Escape");
  await expect(next.getByRole("textbox")).toHaveText("Unpublished draft");
  await expect(next.getByText("Unsaved changes")).toBeVisible();
  expect(await readFile(next, path)).toBe("Final draft");
});

test("restore one change without disturbing newer paragraphs or mixed line endings, then undo", async ({
  page,
}) => {
  const path = "/notes/report.md";
  const middle = "Unchanged paragraph\r\n".repeat(2100);
  const earlier = `\uFEFFFirst\r\nLost paragraph  \n${middle}Closing`;
  const current = `\uFEFFFirst\r\n${middle}New ending  \n`;
  await launch(page, {
    files: { [path]: current },
    appData: { [`history:${path}`]: "[1]", [`snapshot:1:${path}`]: earlier },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await runMenuItem(page, "file.history");
  const dialog = page.getByRole("dialog", { name: "Version History" });
  await dialog.getByLabel("To version").selectOption({ label: "Current draft" }, { timeout: 3000 });
  await expect(dialog.getByRole("button", { name: "Restore this change" })).toHaveCount(2);
  await dialog.getByRole("button", { name: "Restore this change" }).first().click();
  await expect
    .poll(() => readFile(page, path))
    .toBe(`\uFEFFFirst\r\nLost paragraph  \n${middle}New ending  \n`);
  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(() => readFile(page, path)).toBe(current);
});

test("whole restore preserves the current draft in history and autosaves a single undo", async ({
  page,
}) => {
  const path = "/notes/report.md";
  const earlier = "\uFEFFFirst\r\nEarlier ending  ";
  const current = "Latest paragraph\nDo not lose this\r";
  await launch(page, {
    files: { [path]: current },
    appData: { [`history:${path}`]: "[1]", [`snapshot:1:${path}`]: earlier },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await runMenuItem(page, "file.history");
  const dialog = page.getByRole("dialog", { name: "Version History" });
  await dialog.getByRole("button", { name: "Restore entire version" }).click({ timeout: 3000 });
  await expect.poll(() => readFile(page, path)).toBe(earlier);
  await runMenuItem(page, "file.history");
  await expect(dialog.locator("del")).toContainText(["Latest paragraph", "Do not lose this"]);
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(() => readFile(page, path)).toBe(current);
});

test("autosave leaves an external change after a history restore for the author to resolve", async ({
  page,
}) => {
  const path = "/notes/report.md";
  await launch(page, {
    files: { [path]: "Current draft" },
    appData: { [`history:${path}`]: "[1]", [`snapshot:1:${path}`]: "Earlier draft" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await runMenuItem(page, "file.history");
  await page.getByRole("button", { name: "Restore entire version" }).click();
  await externalWrite(page, path, "External revision");
  await expect(page.getByText("was changed by another program")).toBeVisible();
  await page.waitForTimeout(2000);
  expect(await readFile(page, path)).toBe("External revision");
  await expect(page.getByRole("textbox")).toHaveText("Earlier draft");
});
