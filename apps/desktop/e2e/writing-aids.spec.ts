import { expect, type Page, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

async function openDocument(page: Page, text: string, settings?: object) {
  const path = "/notes/doc.md";
  await launch(page, {
    files: { [path]: text, ...(settings ? { [settingsPath]: JSON.stringify(settings) } : {}) },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeFocused();
  return path;
}

const status = (page: Page) => page.locator("footer");
const opacityOf = (page: Page, lineText: string) =>
  page
    .locator(".cm-line", { hasText: lineText })
    .evaluate((line) => Number(getComputedStyle(line).opacity));

test("the status bar shows words, characters and reading time, counting Chinese per character", async ({
  page,
}) => {
  await openDocument(page, "# 写作 Notes\n\n中文和 English mixed.\n");
  await expect(status(page)).toContainText("8 words");
  await expect(status(page)).toContainText("23 characters");
  await expect(status(page)).toContainText("1 min read");

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("再见 bye");
  await expect(status(page)).toContainText("11 words");
  await expect(status(page)).toContainText("28 characters");
});

test("the status bar is translated", async ({ page }) => {
  const path = "/notes/doc.md";
  await launch(page, {
    files: { [path]: "你好 world\n" },
    openDialogResults: [path],
    locale: "zh-CN",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(status(page)).toContainText("3 字");
  await expect(status(page)).toContainText("7 字符");
  await expect(status(page)).toContainText("阅读约 1 分钟");
});

test("F8 toggles focus mode, which dims everything but the current paragraph and is saved in settings", async ({
  page,
}) => {
  await openDocument(page, "First paragraph\n\nSecond paragraph");
  await expect.poll(() => opacityOf(page, "Second")).toBe(1);

  await page.keyboard.press("F8");
  // The cursor is in the first paragraph.
  await expect.poll(() => opacityOf(page, "Second")).toBeLessThan(0.5);
  await expect.poll(() => opacityOf(page, "First")).toBe(1);
  await expect
    .poll(async () => JSON.parse((await readFile(page, settingsPath)) ?? "{}"))
    .toEqual({ focusMode: true });

  await page.keyboard.press("ControlOrMeta+End");
  await expect.poll(() => opacityOf(page, "First")).toBeLessThan(0.5);
  await expect.poll(() => opacityOf(page, "Second")).toBe(1);

  await page.keyboard.press("F8");
  await expect.poll(() => opacityOf(page, "First")).toBe(1);
});

test("focus and typewriter mode can be switched from the command palette and the settings window", async ({
  page,
}) => {
  await openDocument(page, "One\n\nTwo\n");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page
    .getByRole("dialog", { name: "Command Palette" })
    .getByRole("combobox")
    .fill("typewriter");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => JSON.parse((await readFile(page, settingsPath)) ?? "{}"))
    .toEqual({ typewriterMode: true });

  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByLabel("Typewriter mode")).toBeChecked();
  await page.getByLabel("Focus mode").check();
  await expect
    .poll(async () => JSON.parse((await readFile(page, settingsPath)) ?? "{}"))
    .toEqual({ typewriterMode: true, focusMode: true });
  await expect.poll(() => opacityOf(page, "Two")).toBeLessThan(0.5);
});

/** How far the cursor is from the vertical middle of the editor, in pixels. */
const offCenter = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller")?.getBoundingClientRect();
    // The DOM selection follows the editor's while it has focus.
    const node = getSelection()?.focusNode;
    const element = node instanceof Element ? node : node?.parentElement;
    const cursor = element?.closest(".cm-line")?.getBoundingClientRect();
    if (!scroller || !cursor) return Number.POSITIVE_INFINITY;
    return Math.abs(cursor.top + cursor.height / 2 - (scroller.top + scroller.height / 2));
  });

const longText = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`).join("\n\n");

test("typewriter mode keeps the line with the cursor in the middle of the editor", async ({
  page,
}) => {
  await openDocument(page, longText, { typewriterMode: true });
  // Even the first line is brought to the middle.
  await expect.poll(() => offCenter(page)).toBeLessThan(30);

  await page.keyboard.press("ControlOrMeta+End");
  await expect.poll(() => offCenter(page)).toBeLessThan(30);
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.type(" typed");
  await expect.poll(() => offCenter(page)).toBeLessThan(30);
});

test("without typewriter mode the editor scrolls only as far as it must", async ({ page }) => {
  await openDocument(page, longText);
  await page.keyboard.press("ControlOrMeta+End");
  await expect.poll(() => offCenter(page)).toBeGreaterThan(100);
});
