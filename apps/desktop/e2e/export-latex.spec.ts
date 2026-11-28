import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

async function formats(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("option", { name: "Import / Export…", exact: true }).click();
  return page.getByRole("dialog", { name: "Import / Export", exact: true });
}

test("LaTeX alone typesets the current draft and can be disabled independently", async ({
  page,
}, info) => {
  const manuscript =
    "# 结果 Results & limits\n\n- Yield: 50%\n- Mass $m_1$\n\n$$\n\\frac{a}{b}\n$$\n\n";
  await launch(page, {
    locale: "en-US",
    files: { "/notes/report.md": manuscript, [settingsPath]: '{"autosave":false}' },
    openDialogResults: ["/notes/report.md"],
    saveDialogResults: ["/notes/report.tex"],
  });
  await page.keyboard.press("ControlOrMeta+o");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("Unpublished findings.");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const plugin = settings.getByRole("group", { name: "LaTeX export" });
  await expect(plugin).toBeVisible();
  await plugin.getByRole("button", { name: "Install", exact: true }).click();
  await settings.getByRole("button", { name: "Allow access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const dialog = await formats(page);
  const options = dialog.getByLabel("Format");
  await expect(options.locator("option")).toHaveText(["HTML", "PDF", "DOCX", "LaTeX"]);
  await options.selectOption("latex");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const source = await readFile(page, "/notes/report.tex");
  for (const fragment of [
    "\\section{结果 Results \\& limits}",
    "\\begin{itemize}",
    "\\item Yield: 50\\%",
    "\\item Mass $m_1$",
    "\\frac{a}{b}",
    "Unpublished findings.",
  ])
    expect(source).toContain(fragment);
  const texPath = info.outputPath("report.tex");
  await writeFile(texPath, source ?? "");
  // Compile the exact artifact on workstations with TeX Live or MiKTeX installed.
  const compiler = spawnSync(
    "pdflatex",
    ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", texPath],
    {
      cwd: info.outputDir,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if ((compiler.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
    expect(compiler.status, compiler.error?.message ?? compiler.stdout).toBe(0);
  }
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Disable", exact: true }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await formats(page);
  await expect(options.locator("option")).toHaveText(["HTML", "PDF", "DOCX"]);
  expect(await readFile(page, "/notes/report.md")).toBe(manuscript);
});
