import { expect, type Page, test } from "@playwright/test";
import JSZip from "jszip";
import { launch, readBinaryFile, readFile, savedDialogs, settingsPath } from "./memory-platform.ts";

const manuscript =
  "# Field notes\n\n- First item\n\n| City |\n| --- |\n| Tokyo |\n\n![Map](map.png)\n";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function chooseWord(page: Page, destination: string | null) {
  await launch(page, {
    files: { "/notes/report.md": manuscript, [settingsPath]: '{"autosave":false}' },
    binaryFiles: { "/notes/map.png": png },
    openDialogResults: ["/notes/report.md"],
    saveDialogResults: [destination],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nDraft addition");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("option", { name: "Import / Export…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import / Export", exact: true });
  await expect(dialog.getByLabel("Format").locator('option[value="docx"]')).toHaveText("DOCX");
  await dialog.getByLabel("Format").selectOption("docx");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  return dialog;
}

test("exports editable Word structures, an embedded image and unsaved text", async ({ page }) => {
  const dialog = await chooseWord(page, "/notes/share.docx");
  await expect(dialog).toHaveCount(0, { timeout: 30000 });
  expect(await savedDialogs(page)).toEqual(["/notes/report.docx"]);
  const zip = await JSZip.loadAsync(
    Uint8Array.from((await readBinaryFile(page, "/notes/share.docx")) ?? []),
  );
  const xml = await zip.file("word/document.xml")?.async("string");
  expect(xml).toMatch(/<w:pStyle w:val="Heading1"/i);
  expect(xml).toContain("Field notes");
  expect(xml).toContain("<w:numPr>");
  expect(xml).toContain("First item");
  expect(xml).toContain("<w:tbl>");
  expect(xml).toContain("Tokyo");
  expect(xml).toContain("Draft addition");
  expect(xml).toContain("<w:drawing>");
  const image = zip.file(/^word\/media\/.+\.png$/i)[0];
  expect(await image?.async("base64")).toBe(png);
  expect(await readFile(page, "/notes/report.md")).toBe(manuscript);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});

test("cancelling the DOCX save dialog keeps the draft and original", async ({ page }) => {
  const dialog = await chooseWord(page, null);
  await expect(dialog).toHaveCount(0);
  expect(await readBinaryFile(page, "/notes/report.docx")).toBeUndefined();
  expect(await readFile(page, "/notes/report.md")).toBe(manuscript);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});

test("a failed DOCX write leaves the original and unsaved draft available", async ({ page }) => {
  const dialog = await chooseWord(page, "/missing/share.docx");
  await expect(dialog.getByRole("alert")).toContainText("Could not export");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await readBinaryFile(page, "/missing/share.docx")).toBeUndefined();
  expect(await readFile(page, "/notes/report.md")).toBe(manuscript);
  await expect(page.locator(".cm-content")).toContainText("Draft addition");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});
