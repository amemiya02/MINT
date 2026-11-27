import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

test("a relative Markdown link opens its target and places the caret on the cited heading", async ({
  page,
}) => {
  const draft = "/notes/draft.md";
  const report = "/notes/source files/report.md";
  await launch(page, {
    files: {
      [draft]: "# Draft\n\n[Read report](source%20files/report.md#test-results)",
      [report]: "# Report\n\n## Test results\n\nOther text",
    },
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.getByRole("treeitem", { name: "draft.md" }).click();
  await page.getByText("Read report", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveTitle("report.md — MINT");
  await page.keyboard.press("End");
  await page.keyboard.type(" verified");
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, report))
    .toBe("# Report\n\n## Test results verified\n\nOther text");
});

for (const [fragment, message] of [
  ["missing", "Heading not found"],
  ["repeated", "Multiple headings match"],
] as const) {
  test(`a chapter link reports ${fragment} targets`, async ({ page }) => {
    const path = "/notes/draft.md";
    await launch(page, {
      files: { [path]: `# Draft\n\n[Go](#${fragment})\n\n## Repeated\n\n## Repeated` },
      openDialogResults: [path],
      locale: "en-US",
    });
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByText("Go", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByRole("alert")).toContainText(fragment);
  });
}

test("insert and follow a local chapter link while preserving the rest of the source", async ({
  page,
}) => {
  const path = "/notes/draft.md";
  const prefix = "\uFEFF# Draft\r\n\r\n## Résumé\n\nKeep trailing spaces.  \r\n\r\n";
  await launch(page, {
    files: { [path]: `${prefix}Details` },
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  expect(await readFile(page, path)).toBe(`${prefix}Details`);
  await page.getByRole("treeitem", { name: "draft.md" }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type("#r%C3%A9sum%C3%A9");
  await page.keyboard.press("ControlOrMeta+S");
  const link = "[Details](#r%C3%A9sum%C3%A9)";
  await expect.poll(() => readFile(page, path)).toBe(prefix + link);
  await page.keyboard.press("ControlOrMeta+Home");
  await page.getByText("Details", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent,
      ),
    )
    .toContain("Résumé");
});

test("a numbered Markdown anchor identifies the second of two repeated headings", async ({
  page,
}) => {
  const path = "/notes/guide.md";
  await launch(page, {
    files: { [path]: "# Guide\n\n[Second](#usage-1)\n\n## Usage\n\nFirst.\n\n## Usage\n\nSecond." },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByText("Second", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("End");
  await page.keyboard.type(" verified");
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe("# Guide\n\n[Second](#usage-1)\n\n## Usage\n\nFirst.\n\n## Usage verified\n\nSecond.");
});
