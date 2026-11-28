import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import JSZip from "jszip";
import { launch, readBinaryFile, readFile, settingsPath } from "./memory-platform.ts";

async function settings(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  return page.getByRole("dialog", { name: "Settings" });
}

async function exporter(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("option", { name: "Import / Export…", exact: true }).click();
  return page.getByRole("dialog", { name: "Import / Export", exact: true });
}

test("settings controls the EPUB contribution alongside built-in formats", async ({ page }) => {
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+n");
  const dialog = await settings(page);
  const plugin = dialog.getByRole("group", { name: "EPUB export" });
  await expect(plugin).toBeVisible();
  await plugin.getByRole("button", { name: "Install", exact: true }).click();
  await dialog.getByRole("button", { name: "Allow access" }).click();
  for (const [action, enabled] of [
    [null, true],
    ["Disable", false],
    ["Enable", true],
    ["Uninstall", false],
  ] as const) {
    if (action) await plugin.getByRole("button", { name: action }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const formats = await exporter(page);
    await expect(formats.getByLabel("Format").locator("option")).toHaveText(
      enabled ? ["HTML", "PDF", "DOCX", "EPUB"] : ["HTML", "PDF", "DOCX"],
    );
    await formats.getByRole("button", { name: "Cancel" }).click();
    if (action !== "Uninstall") await settings(page);
  }
});

const manuscript = "# Introduction & scope\n\nFirst section.\n\n## Results\n\n";

async function startDraft(page: Page, destinations: (string | null)[]) {
  await launch(page, {
    locale: "en-US",
    files: { "/notes/report.md": manuscript, [settingsPath]: '{"autosave":false}' },
    openDialogResults: ["/notes/report.md"],
    saveDialogResults: destinations,
  });
  await page.keyboard.press("ControlOrMeta+o");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("Unpublished findings.");
  const prefs = await settings(page);
  await prefs
    .getByRole("group", { name: "EPUB export" })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await prefs.getByRole("button", { name: "Allow access" }).click();
  await prefs.getByRole("button", { name: "Close", exact: true }).click();
}

async function exportBook(page: Page) {
  const dialog = await exporter(page);
  await dialog.getByLabel("Format").selectOption("epub");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  return dialog;
}

test("the electronic book contains the draft and navigable sections", async ({ page }, info) => {
  await startDraft(page, ["/notes/book.epub"]);
  await expect(await exportBook(page)).toHaveCount(0);
  const bytes = Buffer.from((await readBinaryFile(page, "/notes/book.epub")) ?? []);
  const zip = await JSZip.loadAsync(bytes);
  expect(await zip.file("mimetype")?.async("string")).toBe("application/epub+zip");
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const packagePath = /full-path="([^"]+)"/.exec(container ?? "")?.[1];
  expect(packagePath).toBeTruthy();
  const opf = await zip.file(packagePath ?? "")?.async("string");
  expect(opf).toContain("<spine>");
  const documents = await Promise.all(zip.file(/\.xhtml$/).map((file) => file.async("string")));
  expect(documents.some((xml) => xml.includes('epub:type="toc"') && xml.includes("Results"))).toBe(
    true,
  );
  expect(documents.join("")).toContain("Introduction &amp; scope");
  expect(documents.join("")).toContain("Unpublished findings.");
  expect(await readFile(page, "/notes/report.md")).toBe(manuscript);
  await writeFile(info.outputPath("report.epub"), bytes);
});

test("cancelled and failed EPUB exports preserve the draft and its file", async ({ page }) => {
  await startDraft(page, [null, "/missing/book.epub", "/notes/report.md"]);
  await expect(await exportBook(page)).toHaveCount(0);
  for (const reason of ["Could not export", "Choose a file different from the manuscript"]) {
    const dialog = await exportBook(page);
    await expect(dialog.getByRole("alert")).toContainText(reason);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }
  expect(await readFile(page, "/notes/report.md")).toBe(manuscript);
  expect(await readBinaryFile(page, "/notes/report.md")).toBeUndefined();
  await expect(page.locator(".cm-content")).toContainText("Unpublished findings.");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});
