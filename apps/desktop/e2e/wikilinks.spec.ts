import { expect, type Page, test } from "@playwright/test";
import { launch, readFile, runMenuItem } from "./memory-platform.ts";

async function openFolder(page: Page, filename: string) {
  await runMenuItem(page, "file.openFolder");
  await page.getByRole("treeitem", { name: filename, exact: true }).click();
}

async function folderSetting(page: Page, root: string, enabled: boolean, change?: boolean) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const checkbox = dialog.getByRole("checkbox", {
    name: `Recognize wikilinks in ${root}`,
    exact: true,
  });
  await expect(checkbox).toBeChecked({ checked: enabled });
  if (change !== undefined) await checkbox.setChecked(change);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}

test("each folder remembers its own wikilink setting", async ({ page }) => {
  await launch(page, {
    files: { "/research/a.md": "[[Report]]", "/drafts/b.md": "[[Report]]" },
    openFolderDialogResults: ["/research", "/drafts", "/research", "/drafts"],
    locale: "en-US",
  });
  await openFolder(page, "a.md");
  await folderSetting(page, "/research", false, true);
  await openFolder(page, "b.md");
  await folderSetting(page, "/drafts", false, true);
  await folderSetting(page, "/drafts", true, false);
  await openFolder(page, "a.md");
  await folderSetting(page, "/research", true);
  await openFolder(page, "b.md");
  await folderSetting(page, "/drafts", false);
});

test("an existing wikilink previews and opens a named section only in the enabled folder", async ({
  page,
}) => {
  const source = "\uFEFF# Draft\r\n\r\nCompare [[Report#Results|field notes]].  \r\n";
  const report = "# Report\n\nIntroduction\n\n## Results\n\nA flock of herons.";
  await launch(page, {
    files: {
      "/research/a.md": source,
      "/research/data/Report.markdown": report,
      "/drafts/b.md": source,
      "/drafts/Report.md": "# Other",
    },
    openFolderDialogResults: ["/research", "/drafts", "/research"],
    locale: "en-US",
  });
  await openFolder(page, "a.md");
  await folderSetting(page, "/research", false, true);
  const label = page.getByRole("tabpanel").getByText("field notes", { exact: true });
  await label.click({ modifiers: ["Alt"] });
  const preview = page.getByRole("dialog", { name: "Link preview" });
  await expect(preview).toContainText("A flock of herons.");
  await expect(preview).not.toContainText("Introduction");
  await page.keyboard.press("Escape");
  await label.click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveTitle("Report.markdown — MINT");
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent,
      ),
    )
    .toContain("Results");

  await openFolder(page, "b.md");
  await expect(label).toHaveCount(0);
  await page
    .getByRole("tabpanel", { name: "b.md" })
    .getByText(/Report#Results\|field notes/)
    .click({ modifiers: ["Alt"] });
  await expect(preview).toHaveCount(0);
  await openFolder(page, "a.md");
  await label.click();
  await page.keyboard.press("ControlOrMeta+Alt+Enter");
  await preview.getByRole("button", { name: "Open in other pane" }).click();
  await expect(
    page.getByRole("tabpanel", { name: "Report.markdown" }).getByRole("textbox"),
  ).toBeFocused();
  await page.getByRole("button", { name: "Close reference pane" }).click();
  await folderSetting(page, "/research", true, false);
  await expect(label).toHaveCount(0);
  expect(await readFile(page, "/research/a.md")).toBe(source);
  expect(await readFile(page, "/research/data/Report.markdown")).toBe(report);
});

test("backlinks select the exact source occurrence and omit disabled, literal and ambiguous wikilinks", async ({
  page,
}) => {
  const source =
    "\uFEFF# Draft\r\n\r\n[[reports/Survey#Birds|bird count]] and [[Survey]].  \r\n\r\n`[[reports/Survey]]`\r\n\r\n[standard](reports/Survey.md)";
  const target = "/research/reports/Survey.md";
  await launch(page, {
    files: {
      "/research/a.md": source,
      [target]: "# Birds",
      "/research/old/Survey.md": "# Archive",
    },
    openFolderDialogResults: ["/research"],
    openDialogResults: [target],
    locale: "en-US",
  });
  await openFolder(page, "a.md");
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByRole("button", { name: "Backlinks", exact: true }).click();
  const results = page.getByRole("complementary", { name: "Backlinks" }).getByRole("button");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText("standard");
  await folderSetting(page, "/research", false, true);
  await expect(results).toHaveCount(2);
  await results.filter({ hasText: "bird count" }).click();
  await expect(page).toHaveTitle("a.md — MINT");
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("[[reports/Survey#Birds|bird count]]");
  await page.getByRole("tab", { name: "Survey.md", exact: true }).click();
  await folderSetting(page, "/research", true, false);
  await expect(results).toHaveCount(1);
  expect(await readFile(page, "/research/a.md")).toBe(source);
});

test("missing and same-name wikilinks explain why they cannot open or preview", async ({
  page,
}) => {
  await launch(page, {
    files: {
      "/notes/source.md": "# Draft\n\n[[Missing]] and [[Survey]]",
      "/notes/old/Survey.md": "# Old",
      "/notes/new/Survey.md": "# New",
      "/other/Missing.md": "# Outside",
    },
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  await openFolder(page, "source.md");
  await folderSetting(page, "/notes", false, true);
  for (const [name, details] of [
    ["Missing", ["Document not found: Missing"]],
    ["Survey", ["Multiple documents match: Survey", "old/Survey.md", "new/Survey.md"]],
  ] as const) {
    const link = page.getByRole("tabpanel").getByText(name, { exact: true });
    await link.click({ modifiers: ["Alt"] });
    const preview = page.getByRole("dialog", { name: "Link preview" });
    for (const detail of details) await expect(preview.getByRole("alert")).toContainText(detail);
    await expect(preview.getByRole("button", { name: "Open in other pane" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await link.click({ modifiers: ["ControlOrMeta"] });
    for (const detail of details) await expect(page.getByRole("alert")).toContainText(detail);
    await expect(page.getByRole("tab")).toHaveCount(1);
  }
});

test("the Link command still writes standard Markdown in a wikilink folder", async ({ page }) => {
  const prefix = "\uFEFF# Draft\r\n\r\nExisting [[Report]].  \r\n\n";
  const path = "/notes/draft.md";
  await launch(page, {
    files: { [path]: `${prefix}Details`, "/notes/Report.md": "# Report" },
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  await openFolder(page, "draft.md");
  await folderSetting(page, "/notes", false, true);
  await page.getByRole("tabpanel").getByRole("textbox").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type("Report.md#report");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(`${prefix}[Details](Report.md#report)`);
});
