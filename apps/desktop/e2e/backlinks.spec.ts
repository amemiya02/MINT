import { expect, test } from "@playwright/test";
import { externalWrite, launch, readFile } from "./memory-platform.ts";

test("backlinks locate individual Markdown references without changing either document", async ({
  page,
}) => {
  const target = "/notes/report.md";
  const path = "/notes/source.md";
  const source =
    "\uFEFF# Draft\r\n\r\nCompare [first](report.md) and [second][chapter].  \r\n\r\n[chapter]: report.md#results\r\n\r\n`[example](report.md)`";
  await launch(page, {
    files: { [target]: "# Results", [path]: source },
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.getByRole("treeitem", { name: "report.md" }).click();
  await page.getByRole("button", { name: "Backlinks", exact: true }).click({ timeout: 3000 });
  const results = page.getByRole("complementary", { name: "Backlinks" }).getByRole("button");
  await expect(results).toHaveCount(2);
  await expect(results.nth(1)).toContainText("source.md");
  await expect(results.nth(1)).toContainText("Compare");
  await results.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveTitle("source.md — MINT");
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("[second][chapter]");
  expect(await readFile(page, path)).toBe(source);
  expect(await readFile(page, target)).toBe("# Results");
});

test("the open backlink list tracks source changes on disk", async ({ page }) => {
  const path = "/notes/draft.md";
  const target = "/notes/report.md";
  await launch(page, {
    files: { [target]: "# Results", [path]: "Discuss [report](report.md)." },
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.getByRole("treeitem", { name: "report.md" }).click();
  await page.getByRole("button", { name: "Backlinks", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Backlinks" });
  await expect(panel.getByRole("button")).toContainText("Discuss");
  await externalWrite(page, path, "No citation.");
  await expect(panel).toContainText("No backlinks.");
  await externalWrite(page, path, "See [revised](./report.md#results).");
  await panel.getByRole("button", { name: /revised/ }).click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("[revised](./report.md#results)");
});
