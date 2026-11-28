import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

test("preview a document from its link and continue writing in the same tab", async ({ page }) => {
  await launch(page, {
    files: {
      "/notes/draft.md": "# Draft\n\n[Reference](sources/report.md)",
      "/notes/sources/report.md": "# Field report\n\nThe expedition returned.",
    },
    openDialogResults: ["/notes/draft.md"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByText("Reference", { exact: true }).click({ modifiers: ["Alt"] });
  const preview = page.getByRole("dialog", { name: "Link preview" });
  await expect(preview.getByRole("heading", { name: "Field report" })).toBeVisible();
  await expect(preview).toContainText("The expedition returned.");
  await expect(page.getByRole("tab", { includeHidden: true })).toHaveCount(1);
  await preview.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(page).toHaveTitle("draft.md — MINT");
});

test("the command palette previews the cited section and Escape restores the writing position", async ({
  page,
}) => {
  const path = "/notes/draft.md";
  const draft = `${"Earlier paragraph.\n\n".repeat(80)}[Evidence](report.md#test-results)`;
  await launch(page, {
    files: {
      [path]: draft,
      "/notes/report.md":
        "# Report\n\nOpening.\n\nTest *results*\n------------\n\nFound it.\n\n### Details\n\nSample A.\n\n## Appendix\n\nOther text.",
    },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.keyboard.press("ControlOrMeta+/");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  for (const _ of "Evidence") await page.keyboard.press("Shift+ArrowRight");
  const selection = () => page.evaluate(() => window.getSelection()?.toString());
  const scroll = () => page.locator(".cm-scroller").evaluate((el) => el.scrollTop);
  await expect.poll(selection).toBe("Evidence");
  await expect.poll(scroll).toBeGreaterThan(0);
  const before = await scroll();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox").fill("Preview link");
  await expect(page.getByRole("option")).toContainText("Preview link");
  await page.getByRole("combobox").press("Enter");
  const preview = page.getByRole("dialog", { name: "Link preview" });
  await expect(preview.getByRole("heading", { name: "Test results" })).toBeVisible();
  await expect(preview).toContainText("Sample A.");
  await expect(preview).not.toContainText("Opening.");
  await expect(preview).not.toContainText("Appendix");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect.poll(selection).toBe("Evidence");
  await expect.poll(scroll).toBe(before);
  await page.keyboard.type("Source");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(draft.replace("[Evidence]", "[Source]"));
});

test("missing and ambiguous targets replace the previous preview with an explanation", async ({
  page,
}) => {
  const path = "/notes/draft.md";
  await launch(page, {
    files: {
      [path]:
        "# Draft\n\n[Valid](report.md#part-1) · [Missing file](absent.md) · [Missing chapter](report.md#lost) · [Ambiguous](report.md#part)",
      "/notes/report.md": "# Part\n\nFirst entry.\n\n# Part\n\nSecond entry.",
    },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const preview = page.getByRole("dialog", { name: "Link preview" });
  await page.getByText("Valid", { exact: true }).click({ modifiers: ["Alt"] });
  await expect(preview).toContainText("Second entry.");
  await expect(preview).not.toContainText("First entry.");
  await page.keyboard.press("Escape");
  for (const [label, message] of [
    ["Missing file", "Could not open /notes/absent.md"],
    ["Missing chapter", "Heading not found: lost"],
    ["Ambiguous", "Multiple headings match: part"],
  ] as const) {
    await page.getByText(label, { exact: true }).click({ modifiers: ["Alt"] });
    await expect(preview.getByRole("alert")).toContainText(message);
    await expect(preview).not.toContainText("Second entry.");
    await page.keyboard.press("Escape");
    await expect(page.locator(".cm-content")).toBeFocused();
  }
});

test("a cited section displays images and reference definitions from the target document", async ({
  page,
}) => {
  const path = "/notes/draft.md";
  await launch(page, {
    files: {
      [path]: "# Draft\n\n[Figure](sources/report.md#figure)",
      "/notes/sources/report.md": "# Figure\n\n![Photo][pic]\n\n# Notes\n\n[pic]: photo%20one.png",
    },
    binaryFiles: {
      "/notes/sources/photo one.png":
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.getByText("Figure", { exact: true }).click({ modifiers: ["Alt"] });
  const photo = page.getByRole("dialog").getByRole("img", { name: "Photo" });
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
});

test("preview and navigation resolve the same heading in the current unsaved draft", async ({
  page,
}) => {
  const path = "/notes/draft.md";
  await launch(page, {
    files: { [path]: "# Draft\n\n[Citation](#costs-amp-fees)\n\n## Costs &amp; fees\n\nSubtotal" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" 21");
  const link = page.getByText("Citation", { exact: true });
  await link.click({ modifiers: ["ControlOrMeta"] });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent,
      ),
    )
    .toContain("Costs");
  await link.click({ modifiers: ["Alt"] });
  const preview = page.getByRole("dialog", { name: "Link preview" });
  await expect(preview.getByRole("heading", { name: "Costs & fees" })).toBeVisible();
  await expect(preview).toContainText("Subtotal 21");
});
