import { expect, type Page, test } from "@playwright/test";
import { externalWrite, launch, readFile } from "./memory-platform.ts";

const original = '\uFEFF[Shown][id]\r\n[again][id]\n\r\n[id]: <draft.md#Some%20Heading> "Title"\r';
const draft = "[back](index.md?q=1#top)\r\n[self](#same)\n";
async function preview(page: Page) {
  await launch(page, {
    files: {
      "/notes/index.md": original,
      "/notes/draft.md": draft,
      "/notes/archive/other.md": "",
    },
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.getByRole("treeitem", { name: "draft.md" }).press("F2");
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill("archive/final file.md");
  await name.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Preview link changes" });
  await expect(dialog).toContainText("[Shown][id]");
  return dialog;
}

test("preview, move with standard links and undo restores both documents exactly", async ({
  page,
}) => {
  const dialog = await preview(page);
  await expect(dialog).toContainText("[again][id]");
  await expect(dialog).toContainText("archive/final%20file.md#Some%20Heading");
  expect(await readFile(page, "/notes/index.md")).toBe(original);
  await dialog.getByRole("button", { name: "Move and update links" }).click();
  await expect
    .poll(() => readFile(page, "/notes/archive/final file.md"))
    .toBe("[back](../index.md?q=1#top)\r\n[self](#same)\n");
  expect(await readFile(page, "/notes/index.md")).toBe(
    original.replace("draft.md", "archive/final%20file.md"),
  );
  await page.getByRole("button", { name: "Undo move" }).click();
  await expect.poll(() => readFile(page, "/notes/draft.md")).toBe(draft);
  expect(await readFile(page, "/notes/index.md")).toBe(original);
  expect(await readFile(page, "/notes/archive/final file.md")).toBeUndefined();
});

test("move only and undo preserve link bytes", async ({ page }) => {
  const dialog = await preview(page);
  await dialog.getByRole("button", { name: "Move only", exact: true }).click();
  await expect.poll(() => readFile(page, "/notes/archive/final file.md")).toBe(draft);
  expect(await readFile(page, "/notes/index.md")).toBe(original);
  await page.getByRole("button", { name: "Undo move" }).click();
  await expect.poll(() => readFile(page, "/notes/draft.md")).toBe(draft);
});

test("a changed reference aborts and rolls back earlier writes", async ({ page }) => {
  const dialog = await preview(page);
  await externalWrite(page, "/notes/index.md", "Another writer\r\n");
  await dialog.getByRole("button", { name: "Move and update links" }).click();
  await expect(page.getByRole("alert")).toContainText("/notes/index.md");
  expect(await readFile(page, "/notes/draft.md")).toBe(draft);
  expect(await readFile(page, "/notes/index.md")).toBe("Another writer\r\n");
  expect(await readFile(page, "/notes/archive/final file.md")).toBeUndefined();
});

test("undo preserves newer external content", async ({ page }) => {
  const dialog = await preview(page);
  await dialog.getByRole("button", { name: "Move and update links" }).click();
  const undo = page.getByRole("button", { name: "Undo move" });
  await expect(undo).toBeVisible();
  await externalWrite(page, "/notes/archive/final file.md", "External edit\n");
  await undo.click();
  await expect(page.getByRole("alert")).toContainText("/notes/archive/final file.md");
  expect(await readFile(page, "/notes/index.md")).toBe(
    original.replace("draft.md", "archive/final%20file.md"),
  );
  expect(await readFile(page, "/notes/archive/final file.md")).toBe("External edit\n");
  expect(await readFile(page, "/notes/draft.md")).toBeUndefined();
});

test("a write error names the file and reverses the completed part of the move", async ({
  page,
}) => {
  const dialog = await preview(page);
  await page.evaluate(() => {
    const disk = (
      window as unknown as {
        __MINT_MEMORY_PLATFORM__: import("../src/platform/memory.ts").MemoryPlatform;
      }
    ).__MINT_MEMORY_PLATFORM__;
    const apply = disk.applyDocumentEdit.bind(disk);
    disk.applyDocumentEdit = (edit) =>
      edit.from === "/notes/index.md" ? Promise.reject(new Error("Disk full")) : apply(edit);
  });
  await dialog.getByRole("button", { name: "Move and update links" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Disk full");
  await expect(alert).toContainText("index.md");
  expect(await readFile(page, "/notes/draft.md")).toBe(draft);
  expect(await readFile(page, "/notes/index.md")).toBe(original);
  expect(await readFile(page, "/notes/archive/final file.md")).toBeUndefined();
});

test("an open document follows the move with its rewritten source and follows undo", async ({
  page,
}) => {
  await launch(page, {
    files: { "/notes/draft.md": draft, "/notes/index.md": "", "/notes/archive/other.md": "" },
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  const item = page.getByRole("treeitem", { name: "draft.md" });
  await item.click();
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  const input = page.getByRole("textbox", { name: "Path relative to the current directory" });
  await input.fill("archive/final.md");
  await input.press("Enter");
  await page.getByRole("button", { name: "Move and update links" }).click();
  await expect(page).toHaveTitle("final.md — MINT");
  const content = page.locator(".cm-content");
  await content.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(content).toContainText("../index.md?q=1#top");
  await page.getByRole("button", { name: "Undo move" }).click();
  await expect(page).toHaveTitle("draft.md — MINT");
  await expect(content).not.toContainText("../index.md");
  expect(await readFile(page, "/notes/draft.md")).toBe(draft);
});
