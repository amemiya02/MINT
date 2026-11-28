import { expect, type Page, test } from "@playwright/test";
import { launch } from "./memory-platform.ts";

const folder = "/notes";
const files = {
  "/notes/animals.md": "# Animals\n\nThe Cat sat.\nA **cat** and a concat.\n",
  "/notes/journal/today.md": "Fed the cat today.\n",
  "/notes/reference/cat.md": "# Field guide\n",
  "/notes/dogs.md": "Only dogs here.\n",
  "/notes/photo.png": "cat",
  "/notes/.gitignore": "build/\n",
  "/notes/build/generated.md": "cat\n",
  "/notes/.hidden/secret.md": "cat\n",
  "/elsewhere/outside.md": "cat\n",
};
const searchShortcut = "ControlOrMeta+Shift+F";

async function openFolder(page: Page, locale = "en-US") {
  await launch(page, { files, openFolderDialogResults: [folder], locale });
  await page
    .getByRole("button", { name: locale === "en-US" ? "Open Folder…" : "打开文件夹…" })
    .click();
  await expect(page.getByRole("tree", { name: "notes" })).toBeVisible();
}

const panel = (page: Page) => page.getByRole("search", { name: "Search in Folder" });
const field = (page: Page) => panel(page).getByRole("textbox", { name: "Search in Folder" });
const results = (page: Page) => panel(page).getByRole("list").getByRole("button");
const editor = (page: Page) => page.getByRole("main").getByRole("textbox");

async function resultFiles(page: Page): Promise<string[]> {
  return panel(page)
    .locator("[data-file]")
    .evaluateAll((items) => items.map((i) => i.getAttribute("data-file") ?? ""));
}

test("⌘⇧F searches the documents of the folder, leaving out ignored and hidden files", async ({
  page,
}) => {
  await openFolder(page);
  await page.keyboard.press(searchShortcut);
  await expect(field(page)).toBeFocused();
  await field(page).fill("cat");

  await expect(panel(page).getByText("4 results in 2 documents")).toBeVisible();
  expect(await resultFiles(page)).toEqual(["animals.md", "journal/today.md"]);
  await expect(results(page).filter({ hasText: "The Cat sat." })).toHaveCount(1);
  await expect(results(page).filter({ hasText: "Fed the cat today." })).toHaveCount(1);
});

test("the navigation rail finds a file by name and text in other documents with one query", async ({
  page,
}) => {
  await openFolder(page);
  await page
    .getByRole("navigation", { name: "Document tools" })
    .getByRole("button", { name: "Search in Folder" })
    .click();
  await field(page).fill("cat");
  const names = panel(page).getByRole("region", { name: "File names" });
  const body = panel(page).getByRole("region", { name: "Document text" });
  await expect(body.getByRole("button", { name: /Fed the cat today/ })).toBeVisible();
  await names.getByRole("button", { name: "reference/cat.md" }).click();
  await expect(editor(page)).toContainText("Field guide");
  await body.getByRole("button", { name: /Fed the cat today/ }).click();
  await expect.poll(() => selectionAround(page)).toEqual({ selected: "cat", before: "the " });
});

test("headings follow the current draft while the same file and text query stays open", async ({
  page,
}) => {
  await launch(page, {
    files: {
      "/notes/draft.md": "\uFEFF# Draft\r\n\r\n## Field *notes*\r\n",
      "/notes/reference/field.md":
        "# Reference\n\nTheir field sample.\n\nMethods in the field\n---\n",
    },
    openFolderDialogResults: [folder],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.getByRole("treeitem", { name: "draft.md" }).click();
  await page
    .getByRole("navigation", { name: "Document tools" })
    .getByRole("button", { name: "Search in Folder" })
    .click();
  await field(page).fill("field");
  const headings = panel(page).getByRole("region", { name: "Current document headings" });
  const names = panel(page).getByRole("region", { name: "File names" });
  const body = panel(page).getByRole("region", { name: "Document text" });
  await expect(names.getByRole("button", { name: "reference/field.md" })).toBeVisible();
  await expect(body.getByRole("button", { name: /Their field sample/ })).toBeVisible();
  await headings.getByRole("button", { name: /Field notes/ }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" revised");
  await expect(headings.getByRole("button")).toHaveText(/Field notes revised/);
  await names.getByRole("button", { name: "reference/field.md" }).click();
  await expect(headings.getByRole("button")).toHaveText(/Methods in the field/);
  await page.getByRole("tab", { name: /draft.md/ }).click();
  await expect(headings.getByRole("button")).toHaveText(/Field notes revised/);
});

test("arrow keys reach each result group and Enter opens the focused hit", async ({ page }) => {
  await openFolder(page);
  await page.keyboard.press(searchShortcut);
  await field(page).fill("animals");
  const file = panel(page).getByRole("region", { name: "File names" }).getByRole("button");
  await expect(file).toBeVisible();
  await field(page).press("ArrowDown");
  await expect(file).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(editor(page)).toContainText("The Cat sat.");
  const heading = panel(page)
    .getByRole("region", { name: "Current document headings" })
    .getByRole("button");
  await expect(heading).toBeVisible();
  await field(page).press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(heading).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(editor(page)).toBeFocused();
  await field(page).press("ArrowUp");
  const line = panel(page).getByRole("region", { name: "Document text" }).getByRole("button");
  await expect(line).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => selectionAround(page)).toEqual({ selected: "Animals", before: "# " });
});

test("clicking a result opens the document with the match selected", async ({ page }) => {
  await openFolder(page);
  await page.keyboard.press(searchShortcut);
  await field(page).fill("cat");
  await results(page).filter({ hasText: "and a concat" }).click();

  await expect(page.getByRole("tab", { name: /animals\.md/ })).toBeVisible();
  await expect(editor(page)).toContainText("The Cat sat.");
  await expect(editor(page)).toBeFocused();
  // The first match on line 4 is the bold "cat"; its selection reveals the markers around it.
  await expect.poll(() => selectionAround(page)).toEqual({ selected: "cat", before: "A **" });

  // The second result in an already open document moves the selection within it.
  await field(page).fill("today");
  await results(page).filter({ hasText: "Fed the cat today." }).click();
  await expect(page.getByRole("tab", { name: /today\.md/ })).toBeVisible();
  await expect.poll(() => selectionAround(page)).toEqual({ selected: "today", before: "cat " });
});

test("a text hit finds its line after unsaved edits move it", async ({ page }) => {
  await openFolder(page);
  await page.getByRole("treeitem", { name: "animals.md" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Enter");
  await page.keyboard.press(searchShortcut);
  await field(page).fill("cat");
  await panel(page)
    .getByRole("button", { name: /and a concat/ })
    .click();
  await expect.poll(() => selectionAround(page)).toEqual({ selected: "cat", before: "A **" });
});

test("match case, whole word and regular expressions", async ({ page }) => {
  await openFolder(page);
  await page.keyboard.press(searchShortcut);
  await field(page).fill("cat");
  await expect(panel(page).getByText("4 results in 2 documents")).toBeVisible();

  await panel(page).getByRole("button", { name: "Match Whole Word" }).click();
  await expect(panel(page).getByText("3 results in 2 documents")).toBeVisible();
  await panel(page).getByRole("button", { name: "Match Case" }).click();
  await expect(panel(page).getByText("2 results in 2 documents")).toBeVisible();

  await panel(page).getByRole("button", { name: "Match Whole Word" }).click();
  await panel(page).getByRole("button", { name: "Use Regular Expression" }).click();
  await field(page).fill("^(The|Fed) ");
  await expect(panel(page).getByText("2 results in 2 documents")).toBeVisible();
  await field(page).fill("(");
  await expect(panel(page).getByText("Invalid regular expression")).toBeVisible();
  await field(page).fill("zebra");
  await expect(panel(page).getByText("No results")).toBeVisible();
});

test("without an open folder, search asks for one", async ({ page }) => {
  await launch(page, { files, locale: "en-US" });
  await page.keyboard.press(searchShortcut);
  await expect(panel(page).getByText("Open a folder to search its documents.")).toBeVisible();
});

test("Escape closes the search and shows the file tree again", async ({ page }) => {
  await openFolder(page, "zh-CN");
  await page.keyboard.press(searchShortcut);
  const zhPanel = page.getByRole("search", { name: "在工作文件夹中搜索" });
  await expect(zhPanel).toBeVisible();
  await zhPanel.getByRole("textbox").press("Escape");
  await expect(zhPanel).toBeHidden();
  await expect(page.getByRole("tree", { name: "notes" })).toBeVisible();
});

/** The selected text in the editor and the four characters before it. */
function selectionAround(page: Page) {
  return page.evaluate(() => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const line = (node instanceof Element ? node : node.parentElement)?.closest(".cm-line");
    if (!line) return null;
    const before = document.createRange();
    before.setStart(line, 0);
    before.setEnd(range.startContainer, range.startOffset);
    return { selected: selection.toString(), before: before.toString().slice(-4) };
  });
}
