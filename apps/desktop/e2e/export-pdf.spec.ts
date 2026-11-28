import { expect, type Page, test } from "@playwright/test";
import {
  launch,
  printedDocuments,
  readFile,
  runMenuItem,
  settingsPath,
} from "./memory-platform.ts";

/** A 1×1 PNG. */
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const longCode = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`).join("\n");

const doc = [
  "# Quarterly report",
  "",
  "Growth was $e^{i\\pi}+1=0$ percent.",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "```js",
  "const answer = 42; // the answer",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  Draft --> Publish",
  "```",
  "",
  "![chart](assets/chart.png)",
  "",
  ...Array.from(
    { length: 40 },
    (_, i) => `Paragraph ${i} of filler text to push blocks across pages.\n`,
  ),
  "```ts",
  longCode,
  "```",
  "",
].join("\n");

async function openReport(page: Page) {
  await launch(page, {
    files: { "/notes/report.md": doc },
    binaryFiles: { "/notes/assets/chart.png": pngBase64 },
    openDialogResults: ["/notes/report.md"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeVisible();
}

async function exportPdf(page: Page) {
  await runMenuItem(page, "file.exportPdf");
  const dialog = page.getByRole("dialog", { name: "Export as PDF" });
  await expect(dialog).toBeVisible();
  // Printing always embeds images: the print view has no folder to resolve them against.
  await expect(dialog.getByLabel("Embed images")).toHaveCount(0);
  await expect(dialog.getByLabel("Appearance")).toHaveValue("light");
  await expect(dialog.getByLabel("Theme")).toHaveValue("");
  await dialog.getByLabel("Theme").selectOption({ label: "Newsprint" });
  await dialog.getByRole("button", { name: "Print…" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

test("prints the document with formulas, diagrams and highlighted code", async ({
  page,
  context,
}) => {
  await openReport(page);
  await exportPdf(page);

  const printed = await printedDocuments(page);
  expect(printed).toHaveLength(1);
  // The PDF's suggested name is the document's.
  expect(printed.map((p) => p.title)).toEqual(["report"]);
  const html = printed[0]?.html ?? "";

  const view = await context.newPage();
  await view.route("**/*", (route) => route.abort());
  await view.emulateMedia({ media: "print" });
  await view.setContent(html, { waitUntil: "load" });
  await expect(view.locator("html")).toHaveCSS("background-color", "rgb(243, 242, 238)");
  await expect(view.locator(".katex").first()).toBeVisible();
  await expect(view.locator(".katex-display")).toBeVisible();
  await expect(view.locator(".cm-mint-code-keyword").first()).toHaveText("const");
  await expect(view.locator("figure.mint-mermaid svg").getByText("Publish")).toBeVisible();
  await expect(view.locator('img[alt="chart"]')).toHaveAttribute("src", /^data:image\/png;base64,/);

  // On paper: code blocks, images and diagrams are not split across pages, and
  // long code lines wrap instead of being cut off at the page edge.
  for (const selector of ["pre", "img", "figure.mint-mermaid", ".katex-display"]) {
    await expect(view.locator(selector).first()).toHaveCSS("break-inside", "avoid");
  }
  await expect(view.locator("pre").first()).toHaveCSS("white-space", "pre-wrap");

  // Chromium's own PDF renderer accepts it: a real multi-page PDF comes out.
  const pdf = await view.pdf({ format: "A4" });
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThan(1);
});

test("is in the command palette, in Chinese too", async ({ page }) => {
  await launch(page, {
    files: { "/notes/报告.md": "# 报告\n" },
    openDialogResults: ["/notes/报告.md"],
    locale: "zh-CN",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("导出为 PDF");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "导出为 PDF" });
  await expect(dialog.getByText("存储为 PDF")).toBeVisible();
  await dialog.getByRole("button", { name: "打印…" }).click();
  await expect(dialog).toHaveCount(0);
  const printed = await printedDocuments(page);
  expect(printed.map((p) => p.title)).toEqual(["报告"]);
  expect(printed[0]?.html).toContain("<h1>报告</h1>");
});

test("switches a dark HTML draft to a light PDF from the format chooser", async ({
  page,
  context,
}, testInfo) => {
  const source = "# Review copy\n\n![chart](chart.png)\n\n";
  await launch(page, {
    files: { "/notes/review.md": source, [settingsPath]: '{"autosave":false,"appearance":"dark"}' },
    binaryFiles: { "/notes/chart.png": pngBase64 },
    openDialogResults: ["/notes/review.md"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("Pending revision.");
  await runMenuItem(page, "file.export");
  const dialog = page.getByRole("dialog", { name: "Import / Export", exact: true });
  await expect(dialog.getByLabel("Appearance")).toHaveValue("dark");
  await dialog.getByLabel("Embed images").uncheck();
  await dialog.getByLabel("Format").selectOption("pdf");
  await expect(dialog.getByLabel("Appearance")).toHaveValue("light");
  await expect(dialog.getByLabel("Embed images")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Print…" }).click();
  await expect(dialog).toHaveCount(0);
  const [job] = await printedDocuments(page);
  expect(job?.title).toBe("review");
  const view = await context.newPage();
  await view.setContent(job?.html ?? "");
  await expect(view).toHaveTitle("Review copy");
  await expect(view.getByText("Pending revision.")).toBeVisible();
  await expect(view.getByRole("img", { name: "chart" })).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  const pdf = await view.pdf({ path: testInfo.outputPath("review.pdf") });
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(await readFile(page, "/notes/review.md")).toBe(source);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});
