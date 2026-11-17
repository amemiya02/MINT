import { expect, type Page, test } from "@playwright/test";
import { launch, readFile, runMenuItem, savedDialogs, themesPath } from "./memory-platform.ts";

/** A 1×1 PNG. */
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const doc = [
  "---",
  "title: Report",
  "---",
  "",
  "# Quarterly report",
  "",
  "Growth was $e^{i\\pi}+1=0$ percent.",
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
].join("\n");

const paperTheme = ":root { --mint-heading-fg: rgb(1, 2, 3); }";

async function openReport(page: Page, saveDialogResults: (string | null)[]) {
  await launch(page, {
    files: { "/notes/report.md": doc, [`${themesPath}/Paper.css`]: paperTheme },
    binaryFiles: { "/notes/assets/chart.png": pngBase64 },
    openDialogResults: ["/notes/report.md"],
    saveDialogResults,
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeVisible();
}

test("exports the document as a single HTML file that renders offline", async ({
  page,
  context,
}) => {
  await openReport(page, ["/notes/out.html"]);
  await runMenuItem(page, "file.exportHtml");
  const dialog = page.getByRole("dialog", { name: "Export as HTML" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Theme").selectOption({ label: "Paper" });
  await dialog.getByLabel("Appearance").selectOption({ label: "Dark" });
  await expect(dialog.getByLabel("Embed images")).toBeChecked();
  await dialog.getByRole("button", { name: "Export" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });

  // The save dialog suggests the document's name, next to it.
  expect(await savedDialogs(page)).toEqual(["/notes/report.html"]);
  const html = (await readFile(page, "/notes/out.html")) ?? "";
  expect(html).toContain("<title>Quarterly report</title>");
  expect(html).toContain(paperTheme);
  expect(html).toContain('data-appearance="dark"');
  expect(html).not.toContain("title: Report");

  // Open the exported file with every network request blocked.
  const exported = await context.newPage();
  const requests: string[] = [];
  await exported.route("**/*", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await exported.setContent(html, { waitUntil: "load" });
  await expect(exported.locator("h1")).toHaveText("Quarterly report");
  await expect(exported.locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");
  await expect(exported.locator(".katex")).toBeVisible();
  await expect(exported.locator(".cm-mint-code-keyword").first()).toHaveText("const");
  const diagram = exported.locator("figure.mint-mermaid svg");
  await expect(diagram).toBeVisible();
  await expect(diagram.getByText("Publish", { exact: true })).toBeVisible();
  const image = exported.locator('img[alt="chart"]');
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  // KaTeX's fonts load from the file itself.
  await expect
    .poll(() =>
      exported.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].some((f) => f.family === "KaTeX_Main" && f.status === "loaded");
      }),
    )
    .toBe(true);
  expect(requests).toEqual([]);
});

test("cancelling the save dialog writes nothing", async ({ page }) => {
  await openReport(page, [null]);
  await runMenuItem(page, "file.exportHtml");
  const dialog = page.getByRole("dialog", { name: "Export as HTML" });
  await dialog.getByLabel("Embed images").uncheck();
  await dialog.getByRole("button", { name: "Export" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await savedDialogs(page)).toEqual(["/notes/report.html"]);
  expect(await readFile(page, "/notes/report.html")).toBeUndefined();
});

test("is in the command palette, in Chinese too", async ({ page }) => {
  await launch(page, {
    files: { "/notes/report.md": "# 报告\n" },
    openDialogResults: ["/notes/report.md"],
    saveDialogResults: ["/notes/报告.html"],
    locale: "zh-CN",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("导出");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "导出为 HTML" });
  await dialog.getByRole("button", { name: "导出" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await readFile(page, "/notes/报告.html")).toContain("<h1>报告</h1>");
});
