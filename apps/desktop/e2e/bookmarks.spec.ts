import { expect, test } from "@playwright/test";
import { launch, listPaths, readFile } from "./memory-platform.ts";

test("bookmark and open same-named documents by path, then remove just one", async ({ page }) => {
  const draft = "/notes/draft/report.md";
  const source = "/notes/source/report.md";
  const files = { [draft]: "\uFEFFDraft text  \r\n", [source]: "Source text\n" };
  await launch(page, { files, openDialogResults: [draft, source], locale: "en-US" });
  const before = await listPaths(page);
  await page.getByRole("button", { name: "Bookmarks", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Bookmarks" });
  const add = panel.getByRole("button", { name: "Bookmark current document" });
  await expect(add).toBeDisabled();
  for (const path of [draft, source]) {
    await page.keyboard.press("ControlOrMeta+O");
    await add.click();
    await expect(panel.getByRole("button", { name: path, exact: true })).toHaveCount(1);
    await expect(add).toBeDisabled();
  }
  await panel.getByRole("button", { name: draft, exact: true }).click();
  await expect(page.getByRole("textbox")).toContainText("Draft text");
  await panel.getByRole("button", { name: `Remove bookmark for ${source}` }).click();
  await expect(panel.getByRole("button", { name: source, exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: draft, exact: true })).toBeVisible();
  for (const [path, original] of Object.entries(files))
    expect(await readFile(page, path)).toBe(original);
  expect(await listPaths(page)).toEqual(before);
});

test("reopen a bookmarked document after restarting and keep its removal across restarts", async ({
  page,
}) => {
  const path = "/research/references/report.md";
  await launch(page, {
    files: { [path]: "Field notes" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const bookmarks = page.getByRole("button", { name: "Bookmarks", exact: true });
  const panel = page.getByRole("complementary", { name: "Bookmarks" });
  const entry = panel.getByRole("button", { name: path, exact: true });
  await bookmarks.click();
  await panel.getByRole("button", { name: "Bookmark current document" }).click();
  await expect(entry).toBeVisible();

  await page.reload();
  await bookmarks.click();
  await expect(entry).toBeVisible();
  await entry.press("Enter");
  await expect(page.getByRole("textbox")).toContainText("Field notes");
  await panel.getByRole("button", { name: `Remove bookmark for ${path}` }).click();
  await expect(entry).toHaveCount(0);

  await page.reload();
  await bookmarks.click();
  await expect(panel).toContainText("No bookmarks yet.");
  await expect(entry).toHaveCount(0);
});
