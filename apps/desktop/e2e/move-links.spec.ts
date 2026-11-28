import { expect, type Page, test } from "@playwright/test";
import { externalWrite, launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

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
    appData: {
      "history:/notes/draft.md": "[1]",
      "snapshot:1:/notes/draft.md": "Saved before the move",
    },
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
  await runMenuItem(page, "file.history");
  const history = page.getByRole("dialog", { name: "Version History" });
  await expect(history.locator("del")).toContainText("Saved before the move");
  await history.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Undo move" }).click();
  await expect(page).toHaveTitle("draft.md — MINT");
  await expect(content).not.toContainText("../index.md");
  expect(await readFile(page, "/notes/draft.md")).toBe(draft);
  await runMenuItem(page, "file.history");
  await expect(history.locator("del")).toContainText("Saved before the move");
  await history.getByRole("button", { name: "Close" }).click();
  await externalWrite(page, "/notes/archive/final.md", "Unrelated draft");
  await page.getByRole("treeitem", { name: "archive", exact: true }).press("ArrowRight");
  await page.getByRole("treeitem", { name: "final.md", exact: true }).click();
  await runMenuItem(page, "file.history");
  await expect(history).toContainText("No saved versions yet");
});

const wikiDraft =
  "\uFEFF[standard](Report.md#Results)\r\nFirst [[Report#Results|field notes]]\nSecond [[Report#Results]]\r\nArchive [[Report|older notes]]\n";

async function renameReport(page: Page, destination = "archive/New report.md") {
  await page.getByRole("treeitem", { name: "Report.md", exact: true }).press("F2");
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill(destination);
  await name.press("Enter");
  return page.getByRole("dialog", { name: "Preview link changes" });
}

async function openWikiFolder(page: Page, files: Record<string, string> = {}) {
  await launch(page, {
    files: {
      "/notes/draft.md": wikiDraft,
      "/notes/Report.md": "# Results",
      "/notes/archive/Report.md": "# Older results",
      "/other/draft.md": wikiDraft,
      "/other/Report.md": "# Results",
      "/other/archive/Report.md": "# Older results",
      ...files,
    },
    openFolderDialogResults: ["/notes", "/other"],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("checkbox", { name: "Recognize wikilinks in /notes" }).check();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
}

test("choose each ambiguous wikilink, preview its actual change, and undo the entire move", async ({
  page,
}) => {
  await openWikiFolder(page);
  const preview = await renameReport(page);
  const first = preview.getByRole("listitem").filter({ hasText: "First [[" });
  const second = preview.getByRole("listitem").filter({ hasText: "Second [[" });
  await expect(first).toContainText("draft.md · 2:7");
  const update = preview.getByRole("button", { name: "Move and update links" });
  await expect(update).toBeDisabled();
  await first.getByRole("combobox").selectOption({ label: "Report.md" });
  await expect(first.locator("code")).toHaveText("→ [[archive/New report.md#Results|field notes]]");
  await second.getByRole("combobox").selectOption({ label: "archive/Report.md" });
  await expect(second).toContainText("Keep original link");
  // The same occurrence can be reassigned while previewing.
  await second.getByRole("combobox").selectOption({ label: "Report.md" });
  await expect(second.locator("code")).toHaveText(
    "→ [[archive/New report.md#Results|Report#Results]]",
  );
  await preview
    .getByRole("listitem")
    .filter({ hasText: "Archive [[" })
    .getByRole("combobox")
    .selectOption({ label: "archive/Report.md" });
  expect(await readFile(page, "/notes/draft.md")).toBe(wikiDraft);
  await update.click();
  await expect
    .poll(() => readFile(page, "/notes/draft.md"))
    .toBe(
      "\uFEFF[standard](archive/New%20report.md#Results)\r\nFirst [[archive/New report.md#Results|field notes]]\nSecond [[archive/New report.md#Results|Report#Results]]\r\nArchive [[Report|older notes]]\n",
    );
  expect(await readFile(page, "/notes/archive/New report.md")).toBe("# Results");
  expect(await readFile(page, "/notes/archive/Report.md")).toBe("# Older results");
  expect(await readFile(page, "/notes/Report.md")).toBeUndefined();
  await page.getByRole("button", { name: "Undo move" }).click();
  await expect.poll(() => readFile(page, "/notes/Report.md")).toBe("# Results");
  expect(await readFile(page, "/notes/draft.md")).toBe(wikiDraft);
  expect(await readFile(page, "/notes/archive/New report.md")).toBeUndefined();
});

test("cancel discards target choices and move only preserves all link bytes", async ({ page }) => {
  await openWikiFolder(page);
  const preview = await renameReport(page);
  await preview.getByRole("combobox").first().selectOption({ label: "Report.md" });
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toHaveCount(0);
  expect(await readFile(page, "/notes/Report.md")).toBe("# Results");
  expect(await readFile(page, "/notes/archive/New report.md")).toBeUndefined();
  expect(await readFile(page, "/notes/draft.md")).toBe(wikiDraft);
  await renameReport(page);
  await expect(preview.getByRole("combobox").first()).toHaveValue("");
  await preview.getByRole("button", { name: "Move only", exact: true }).click();
  await expect.poll(() => readFile(page, "/notes/archive/New report.md")).toBe("# Results");
  expect(await readFile(page, "/notes/draft.md")).toBe(wikiDraft);
  expect(await readFile(page, "/notes/Report.md")).toBeUndefined();
  await page.getByRole("button", { name: "Undo move" }).click();
  await expect.poll(() => readFile(page, "/notes/Report.md")).toBe("# Results");
});

test("a second folder with wikilinks disabled updates only standard links", async ({ page }) => {
  await openWikiFolder(page);
  await runMenuItem(page, "file.openFolder");
  await expect(page.getByRole("treeitem", { name: "Report.md" })).toHaveAttribute(
    "title",
    "/other/Report.md",
  );
  const preview = await renameReport(page);
  await expect(preview.getByRole("listitem")).toHaveCount(1);
  await expect(preview.getByRole("listitem")).toContainText("[standard]");
  await preview.getByRole("button", { name: "Move and update links" }).click();
  await expect
    .poll(() => readFile(page, "/other/draft.md"))
    .toBe(wikiDraft.replace("(Report.md", "(archive/New%20report.md"));
  expect(await readFile(page, "/notes/draft.md")).toBe(wikiDraft);
});

test("a moved document keeps its relative wikilinks and remains reachable inside a folder containing #", async ({
  page,
}) => {
  await openWikiFolder(page, {
    "/notes/draft.md": "[[/Report.md#Results|original]]",
    "/notes/Report.md": "See [[./draft]] and `[[./draft]]`.",
    "/notes/#archive/other.md": "",
  });
  const preview = await renameReport(page, "#archive/Final.md");
  await expect(preview).toContainText("→ [[Final.md#Results|original]]");
  await expect(preview).toContainText("→ [[/draft.md|./draft]]");
  await preview.getByRole("button", { name: "Move and update links" }).click();
  await expect
    .poll(() => readFile(page, "/notes/#archive/Final.md"))
    .toBe("See [[/draft.md|./draft]] and `[[./draft]]`.");
  expect(await readFile(page, "/notes/draft.md")).toBe("[[Final.md#Results|original]]");
});

test("a new reference after preview requires another move review", async ({ page }) => {
  const dialog = await preview(page);
  await externalWrite(page, "/notes/new.md", "[draft](draft.md)");
  await dialog.getByRole("button", { name: "Move and update links" }).click();
  await expect(page.getByRole("alert")).toContainText("/notes/new.md");
  expect(await readFile(page, "/notes/draft.md")).toBe(draft);
  expect(await readFile(page, "/notes/index.md")).toBe(original);
});

test("a dirty reference blocks a move with a localized explanation", async ({ page }) => {
  await launch(page, {
    locale: "zh-CN",
    files: {
      "/notes/draft.md": "Draft",
      "/notes/ref.md": "[link](draft.md)",
      [settingsPath]: '{"autosave":false}',
    },
    openFolderDialogResults: ["/notes"],
  });
  await runMenuItem(page, "file.openFolder");
  await page.getByRole("treeitem", { name: "ref.md" }).click();
  await page.getByRole("textbox").fill("[link](draft.md) unsaved");
  await page.getByRole("treeitem", { name: "draft.md" }).press("F2");
  const name = page.getByRole("textbox", { name: "名称" });
  await name.fill("final.md");
  await name.press("Enter");
  await page.getByRole("button", { name: "移动并更新链接" }).click();
  await expect(page.getByRole("alert")).toContainText("/notes/ref.md 有未保存的更改");
  expect(await readFile(page, "/notes/draft.md")).toBe("Draft");
  expect(await readFile(page, "/notes/ref.md")).toBe("[link](draft.md)");
});
