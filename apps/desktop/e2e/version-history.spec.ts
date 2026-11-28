import { expect, test } from "@playwright/test";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import { files, launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

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
