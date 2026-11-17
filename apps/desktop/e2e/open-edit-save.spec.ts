import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

const path = "/notes/todo.md";
// A BOM, CRLF line endings and a final newline: all must survive a save.
const original = "﻿# Todo\r\n\r\n- milk\r\n";

test("open a document, edit it and save it", async ({ page }) => {
  await launch(page, { files: { [path]: original }, openDialogResults: [path], locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+O");
  const editor = page.getByRole("textbox");
  await expect(editor).toContainText("- milk");
  await expect(page).toHaveTitle("todo.md — MINT");

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("- eggs");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe("﻿# Todo\r\n\r\n- milk\r\n- eggs");
});

test("saving an unedited document leaves the file byte-for-byte unchanged", async ({ page }) => {
  await launch(page, { files: { [path]: original }, openDialogResults: [path], locale: "en-US" });

  await page.getByRole("button", { name: "Open Document…" }).click();
  await expect(page.getByRole("textbox")).toContainText("# Todo");
  await page.keyboard.press("ControlOrMeta+S");

  expect(await readFile(page, path)).toBe(original);
});

test("shows the interface in Chinese when the system language is Chinese", async ({ page }) => {
  await launch(page, { files: {}, locale: "zh-CN" });

  await expect(page.getByText("没有打开的文档")).toBeVisible();
  await expect(page.getByRole("button", { name: "打开文档…" })).toBeVisible();
});

test("reports a document that cannot be opened", async ({ page }) => {
  await launch(page, { files: {}, openDialogResults: ["/missing.md"], locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("alert")).toContainText("Could not open /missing.md");
});
