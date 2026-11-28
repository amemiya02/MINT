import { expect, type Page, test } from "@playwright/test";
import JSZip from "jszip";
import { launch, readBinaryFile, readFile } from "./memory-platform.ts";

async function installImporter(page: Page, grant = true) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings
    .getByRole("group", { name: "Notion import" })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await expect(
    settings.getByText(
      "Read the selected archive and create a new folder in the selected destination",
    ),
  ).toBeVisible();
  await settings.getByRole("button", { name: grant ? "Allow access" : "Deny access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
}

async function formats(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("option", { name: "Import / Export…", exact: true }).click();
  return page.getByRole("dialog", { name: "Import / Export" });
}

test("imports a Notion ZIP into a new folder and opens the converted manuscript", async ({
  page,
}) => {
  await launch(page, {
    locale: "en-US",
    directories: ["/chosen"],
    openFolderDialogResults: ["/chosen"],
  });
  await installImporter(page);
  const dialog = await formats(page);
  await dialog.getByLabel("Format").selectOption({ label: "Notion import" });
  const zip = new JSZip();
  const source = "# Notebook\n\n[Child](Pages/Field%20notes.md)\n";
  zip.file("Home.md", source);
  zip.file("Pages/Field notes.md", "# Observations\n\n![Map](map.png)\n");
  zip.file("Pages/map.png", Uint8Array.of(137, 80, 78, 71, 0, 255));
  await dialog.getByLabel("Notion export (.zip)").setInputFiles({
    name: "Notebook.zip",
    mimeType: "application/zip",
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
  });
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await dialog.getByRole("button", { name: "Open imported folder" }).click();
  await page.getByRole("treeitem", { name: "Home.md", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Notebook");
  expect(await readFile(page, "/chosen/Notebook/Home.md")).toEqual(source);
  expect(await readBinaryFile(page, "/chosen/Notebook/Pages/map.png")).toEqual([
    137, 80, 78, 71, 0, 255,
  ]);
});

test("converts HTML pages and Notion page links and locates missing references", async ({
  page,
}) => {
  await launch(page, {
    locale: "en-US",
    directories: ["/chosen"],
    openFolderDialogResults: ["/chosen"],
  });
  await installImporter(page);
  const dialog = await formats(page);
  const zip = new JSZip();
  const id = "4273e611af74402ea6a9ab90cf603710";
  zip.file(
    "Home.html",
    '<article><h1>Home</h1><p><a href="Pages/Child.html#block-id">Details</a></p></article>',
  );
  zip.file("Pages/Child.html", '<h1>Child</h1><h2 id="block-id">Details</h2><p>Nested page</p>');
  zip.file(`Research ${id}.md`, "# Research\n");
  zip.file(
    "Pages/Checklist.md",
    `# Checklist\n[Research](https://www.notion.so/Research-${id})\n![Scan](missing.png)\n[Old page](deleted.md)\n[Missing section](Child.html#removed)\n\n\`[Example](not-a-link)\`\n`,
  );
  await dialog.getByLabel("Notion export (.zip)").setInputFiles({
    name: "Transfer.zip",
    mimeType: "application/zip",
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
  });
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toContainText("Pages/Checklist.md:3");
  await expect(dialog).toContainText("Missing attachment");
  await expect(dialog).toContainText("missing.png");
  await expect(dialog).toContainText("Pages/Checklist.md:4");
  await expect(dialog).toContainText("Unresolved link");
  await expect(dialog).toContainText("deleted.md");
  await expect(dialog).toContainText("Child.html#removed");
  await expect(dialog).not.toContainText("not-a-link");
  expect(await readFile(page, "/chosen/Transfer/Home.md")).toContain(
    "[Details](Pages/Child.md#details)",
  );
  expect(await readFile(page, "/chosen/Transfer/Pages/Child.md")).toContain("## Details");
  expect(await readFile(page, "/chosen/Transfer/Pages/Checklist.md")).toContain(
    `[Research](../Research%20${id}.md)`,
  );
});

test("unpacks Notion's numbered ZIP parts and resolves links across parts", async ({ page }) => {
  await launch(page, {
    locale: "en-US",
    directories: ["/chosen"],
    openFolderDialogResults: ["/chosen"],
  });
  await installImporter(page);
  const dialog = await formats(page);
  const first = new JSZip().file("Index.md", "[Second page](Notes/Page.md)\n");
  const second = new JSZip().file("Notes/Page.md", "# Second page\n");
  const wrapper = new JSZip()
    .file("ExportBlock-123-Part-1.zip", await first.generateAsync({ type: "nodebuffer" }))
    .file("ExportBlock-123-Part-2.zip", await second.generateAsync({ type: "nodebuffer" }));
  await dialog.getByLabel("Notion export (.zip)").setInputFiles({
    name: "Workspace.zip",
    mimeType: "application/zip",
    buffer: await wrapper.generateAsync({ type: "nodebuffer" }),
  });
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("/chosen/Workspace");
  await expect(dialog).not.toContainText("Unresolved link");
  expect(await readFile(page, "/chosen/Workspace/Notes/Page.md")).toBe("# Second page\n");
});

test("a live import loses access when revoked and disappears when disabled", async ({
  page,
  context,
}) => {
  await launch(page, { locale: "en-US" });
  await installImporter(page, false);
  const dialog = await formats(page);
  await expect(dialog.getByRole("alert")).toContainText("Allow archive import");
  await expect(dialog.getByLabel("Notion export (.zip)")).toHaveCount(0);
  const manager = await context.newPage();
  await manager.goto("/");
  await expect(manager.getByText("No document open")).toBeVisible();
  await manager.keyboard.press("ControlOrMeta+,");
  const plugin = manager.getByRole("group", { name: "Notion import" });
  await plugin.getByRole("button", { name: "Allow access" }).click();
  await expect(dialog.getByLabel("Notion export (.zip)")).toBeVisible();
  await plugin.getByRole("button", { name: "Revoke access" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Allow archive import");
  await plugin.getByRole("button", { name: "Disable" }).click();
  await expect(dialog).toHaveCount(0);
});

test("cancelling and retrying never replaces an existing folder", async ({ page }) => {
  await launch(page, {
    locale: "en-US",
    files: { "/chosen/Notebook/Home.md": "Keep this" },
    openFolderDialogResults: [null, "/chosen", "/chosen"],
  });
  await installImporter(page);
  const dialog = await formats(page);
  const zip = new JSZip().file("Home.md", "# New");
  await dialog.getByLabel("Notion export (.zip)").setInputFiles({
    name: "Notebook.zip",
    mimeType: "application/zip",
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
  });
  const submit = dialog.getByRole("button", { name: "Import", exact: true });
  await submit.click();
  await expect(submit).toBeEnabled();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await submit.click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  expect(await readFile(page, "/chosen/Notebook/Home.md")).toBe("Keep this");
  await dialog.getByLabel("New folder name").fill("Imported");
  await submit.click();
  await expect(dialog.getByRole("status")).toContainText("/chosen/Imported");
  expect(await readFile(page, "/chosen/Imported/Home.md")).toBe("# New");
});
