import { expect, type Page, test } from "@playwright/test";
import { launch } from "./memory-platform.ts";

const folder = "/notes";
const files = {
  "/notes/readme.md": "# Readme\n",
  "/notes/meeting-notes.md": "# Meeting notes\n",
  "/notes/journal/2026-11-17.md": "# Today\n",
  "/notes/projects/mint/roadmap.md": "# Roadmap\n",
  "/notes/projects/mint/release-notes.markdown": "# Release notes\n",
  "/notes/photo.png": "not a document",
  "/notes/.git/notes.md": "hidden",
  "/notes/.gitignore": "build/\n*.tmp.md\n!keep.tmp.md\n",
  "/notes/build/generated.md": "# Generated\n",
  "/notes/scratch.tmp.md": "# Scratch\n",
  "/notes/keep.tmp.md": "# Keep\n",
  "/notes/projects/.gitignore": "private.md\n",
  "/notes/projects/private.md": "# Private\n",
  "/elsewhere/outside.md": "# Outside\n",
};

async function openFolder(page: Page, appData: Record<string, string> = {}) {
  await launch(page, { files, appData, openFolderDialogResults: [folder], locale: "en-US" });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await expect(page.getByRole("tree", { name: "notes" })).toBeVisible();
}

const quickOpen = (page: Page) => page.getByRole("dialog", { name: "Quick Open" });
const search = (page: Page) => quickOpen(page).getByRole("combobox");
const results = (page: Page) => quickOpen(page).getByRole("option");
const editor = (page: Page) => page.getByRole("main").getByRole("textbox");

async function names(page: Page): Promise<string[]> {
  return results(page).evaluateAll((options) =>
    options.map((o) => o.getAttribute("data-path") ?? ""),
  );
}

test("⌘P lists the documents of the folder, leaving out ignored and hidden files", async ({
  page,
}) => {
  await openFolder(page);
  await page.keyboard.press("ControlOrMeta+P");
  await expect(search(page)).toBeFocused();

  await expect(results(page)).toHaveCount(6);
  expect((await names(page)).sort()).toEqual([
    "journal/2026-11-17.md",
    "keep.tmp.md",
    "meeting-notes.md",
    "projects/mint/release-notes.markdown",
    "projects/mint/roadmap.md",
    "readme.md",
  ]);
});

test("fuzzy matches file names and opens the chosen document", async ({ page }) => {
  await openFolder(page);
  await page.keyboard.press("ControlOrMeta+P");

  await search(page).fill("rdmp");
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first()).toHaveAttribute("data-path", "projects/mint/roadmap.md");

  await search(page).press("Enter");
  await expect(quickOpen(page)).toBeHidden();
  await expect(editor(page)).toContainText("# Roadmap");
  await expect(page.getByRole("tab", { name: "roadmap.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("results are ranked by relevance", async ({ page }) => {
  await openFolder(page);
  await page.keyboard.press("ControlOrMeta+P");

  await search(page).fill("notes");
  // Both names contain the query at a word start; the shorter path wins.
  await expect
    .poll(() => names(page))
    .toEqual(["meeting-notes.md", "projects/mint/release-notes.markdown"]);

  await search(page).fill("ream");
  // Consecutive letters beat scattered ones, and a match within the file name
  // beats one spread across folder names.
  await expect
    .poll(() => names(page))
    .toEqual(["readme.md", "projects/mint/release-notes.markdown", "projects/mint/roadmap.md"]);
});

test("recently opened documents come first", async ({ page }) => {
  await openFolder(page, {
    "recent.json": JSON.stringify({
      documents: ["/notes/projects/mint/release-notes.markdown", "/elsewhere/outside.md"],
      folders: [],
    }),
  });
  await page.keyboard.press("ControlOrMeta+P");

  // With no query, recent documents of the folder lead the list.
  await expect(results(page)).toHaveCount(6);
  expect((await names(page))[0]).toBe("projects/mint/release-notes.markdown");
  await expect(results(page).first()).toContainText("recently opened");

  // A recent document leads among matches even when another matches better.
  await search(page).fill("notes");
  await expect
    .poll(() => names(page))
    .toEqual(["projects/mint/release-notes.markdown", "meeting-notes.md"]);

  // Opening a document makes it the most recent.
  await search(page).fill("readme");
  await search(page).press("Enter");
  await expect(editor(page)).toContainText("# Readme");
  await page.keyboard.press("ControlOrMeta+P");
  await expect
    .poll(async () => (await names(page)).slice(0, 2))
    .toEqual(["readme.md", "projects/mint/release-notes.markdown"]);
});

test("navigate results with the keyboard and dismiss with Escape", async ({ page }) => {
  await openFolder(page);
  await page.keyboard.press("ControlOrMeta+P");
  await search(page).fill("md");
  await expect(results(page).first()).toHaveAttribute("aria-selected", "true");

  await search(page).press("ArrowDown");
  await expect(results(page).nth(1)).toHaveAttribute("aria-selected", "true");
  const second = await results(page).nth(1).getAttribute("data-path");
  await search(page).press("ArrowUp");
  await expect(results(page).first()).toHaveAttribute("aria-selected", "true");
  await search(page).press("ArrowDown");
  await search(page).press("Enter");
  await expect(page.getByRole("tab", { name: second?.split("/").pop() })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+P");
  await expect(search(page)).toHaveValue("");
  await search(page).fill("zzz");
  await expect(quickOpen(page).getByText("No matching documents")).toBeVisible();
  await search(page).press("Escape");
  await expect(quickOpen(page)).toBeHidden();
});

test("a result can be opened with the mouse", async ({ page }) => {
  await openFolder(page);
  await page.keyboard.press("ControlOrMeta+P");
  await search(page).fill("2026");
  await results(page).first().click();
  await expect(editor(page)).toContainText("# Today");
});

test("without a folder, quick open offers recently opened documents", async ({ page }) => {
  await launch(page, {
    files,
    appData: {
      "recent.json": JSON.stringify({ documents: ["/elsewhere/outside.md"], folders: [] }),
    },
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+P");
  await expect(results(page)).toHaveCount(1);
  await search(page).press("Enter");
  await expect(editor(page)).toContainText("# Outside");
});

test("quick open speaks Chinese", async ({ page }) => {
  await launch(page, { files, locale: "zh-CN" });
  await page.keyboard.press("ControlOrMeta+P");
  await expect(page.getByRole("dialog", { name: "快速打开" })).toBeVisible();
});
