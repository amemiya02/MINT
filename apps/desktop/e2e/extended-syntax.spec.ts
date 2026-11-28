import { expect, type Page, test } from "@playwright/test";
import {
  launch,
  printedDocuments,
  readFile,
  runMenuItem,
  savedDialogs,
  settingsPath,
} from "./memory-platform.ts";

const path = "/notes/typora.md";
const text = "# Notes\n\n[TOC]\n\n## Water\n\nH~2~O is ==wet==, x^2^ is not.\n";

test("extended syntax is text by default and renders as soon as it is switched on in the settings", async ({
  page,
}) => {
  await launch(page, { files: { [path]: text }, openDialogResults: [path], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await page.keyboard.press("ControlOrMeta+End");

  const body = page.locator(".cm-line", { hasText: "is not." });
  await expect(body).toHaveText("H~2~O is ==wet==, x^2^ is not.");
  await expect(page.locator(".cm-mint-toc")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Extended syntax: ==highlight==").check();
  await expect(body).toHaveText("H~2~O is wet, x^2^ is not.");
  await expect(page.locator(".cm-mint-highlight")).toHaveText("wet");

  await settings.getByLabel("Extended syntax: ~subscript~").check();
  await settings.getByLabel("Extended syntax: ^superscript^").check();
  await settings.getByLabel("Extended syntax: [TOC]").check();
  await expect(body).toHaveText("H2O is wet, x2 is not.");
  await expect(page.locator(".cm-mint-toc")).toHaveText(["NotesWater"]);
  expect(JSON.parse((await readFile(page, settingsPath)) ?? "")).toEqual({
    extendedHighlight: true,
    extendedSubscript: true,
    extendedSuperscript: true,
    extendedToc: true,
  });

  await settings.getByLabel("Extended syntax: ==highlight==").uncheck();
  await expect(body).toHaveText("H2O is ==wet==, x2 is not.");

  // Rendering never changes the file.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(text);
});

test("extended syntax switched on in settings.json applies to documents opened later", async ({
  page,
}) => {
  await launch(page, {
    files: { [path]: text, [settingsPath]: '{ "extendedSuperscript": true }' },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.keyboard.press("ControlOrMeta+End");

  await expect(page.locator(".cm-line", { hasText: "is not." })).toHaveText(
    "H~2~O is ==wet==, x2 is not.",
  );
  await expect(page.locator(".cm-mint-superscript")).toHaveText("2");
});

const exportDoc = "# Notes\n\nIt is ==wet==, H~2~O and x^2^.\n";

async function openExportDoc(page: Page, settings: string | null) {
  await launch(page, {
    files: { [path]: exportDoc, ...(settings ? { [settingsPath]: settings } : {}) },
    openDialogResults: [path],
    saveDialogResults: ["/notes/out.html"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeVisible();
}

test("HTML and PDF exports render the extended syntax the editor has switched on", async ({
  page,
}) => {
  await openExportDoc(page, '{ "extendedHighlight": true, "extendedSubscript": true }');

  await runMenuItem(page, "file.exportHtml");
  let dialog = page.getByRole("dialog", { name: "Export as HTML" });
  await dialog.getByRole("button", { name: "Export" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  expect(await savedDialogs(page)).toEqual(["/notes/typora.html"]);
  const html = (await readFile(page, "/notes/out.html")) ?? "";
  expect(html).toContain("<mark>wet</mark>");
  expect(html).toContain("H<sub>2</sub>O");
  // Switched off: stays text, in the export as in the editor.
  expect(html).toContain("x^2^");

  await runMenuItem(page, "file.exportPdf");
  dialog = page.getByRole("dialog", { name: "Export as PDF" });
  await dialog.getByRole("button", { name: "Print…" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  const printed = (await printedDocuments(page))[0]?.html ?? "";
  const printView = await page.context().newPage();
  await printView.setContent(printed);
  await expect(printView.locator("mark")).toHaveText("wet");
  await expect(printView.locator("sub")).toHaveText("2");
  await expect(printView.locator("article")).toContainText("H2O");
  await expect(printView.locator("article")).toContainText("x^2^");
});

test("exports keep extended syntax as text while its switches are off", async ({ page }) => {
  await openExportDoc(page, null);
  await runMenuItem(page, "file.exportHtml");
  const dialog = page.getByRole("dialog", { name: "Export as HTML" });
  await dialog.getByRole("button", { name: "Export" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  const html = (await readFile(page, "/notes/out.html")) ?? "";
  expect(html).not.toContain("<mark>");
  expect(html).toContain("==wet==");
});
