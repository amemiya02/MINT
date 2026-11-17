import { expect, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

const path = "/notes/typora.md";
const text = "# Notes\n\n[TOC]\n\n## Water\n\nH~2~O is ==wet==, x^2^ is not.\n";

test("extended syntax is text by default and renders as soon as it is switched on in the settings", async ({
  page,
}) => {
  await launch(page, { files: { [path]: text }, openDialogResults: [path], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await page.keyboard.press("ControlOrMeta+End");

  const body = page.locator(".cm-line", { hasText: "is not." });
  await expect(body).toHaveText("H~2~O is ==wet==, x^2^ is not.");
  await expect(page.locator(".cm-mint-toc")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Extended syntax: ==highlight==").check();
  await expect(body).toHaveText("H~2~O is wet, x^2^ is not.");
  await expect(page.locator(".cm-mint-highlight")).toHaveText("wet");

  await settings.getByLabel("Extended syntax: ~subscript~").check();
  await settings.getByLabel("Extended syntax: ^superscript^").check();
  await settings.getByLabel("Extended syntax: [TOC]").check();
  await expect(body).toHaveText("H2O is wet, x2 is not.");
  await expect(page.locator(".cm-mint-toc")).toHaveText(["NotesWater"]);
  expect(JSON.parse((await readFile(page, settingsPath)) ?? "")).toEqual({
    extendedHighlight: true,
    extendedSubscript: true,
    extendedSuperscript: true,
    extendedToc: true,
  });

  await settings.getByLabel("Extended syntax: ==highlight==").uncheck();
  await expect(body).toHaveText("H2O is ==wet==, x2 is not.");

  // Rendering never changes the file.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(text);
});

test("extended syntax switched on in settings.json applies to documents opened later", async ({
  page,
}) => {
  await launch(page, {
    files: { [path]: text, [settingsPath]: '{ "extendedSuperscript": true }' },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.keyboard.press("ControlOrMeta+End");

  await expect(page.locator(".cm-line", { hasText: "is not." })).toHaveText(
    "H~2~O is ==wet==, x2 is not.",
  );
  await expect(page.locator(".cm-mint-superscript")).toHaveText("2");
});
