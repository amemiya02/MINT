import { expect, type Page, test } from "@playwright/test";
import type { MemoryPlatformOptions } from "../src/platform/memory.ts";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

const path = "/notes/doc.md";

async function openDocument(page: Page, text: string, options: MemoryPlatformOptions = {}) {
  const { files, ...rest } = options;
  await launch(page, {
    files: { [path]: text, ...files },
    openDialogResults: [path],
    locale: "en-US",
    ...rest,
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeFocused();
}

/** Paste clipboard data into the editor the way the browser delivers it. */
async function pasteData(page: Page, data: Record<string, string>) {
  await page.locator(".cm-content").evaluate((content, data) => {
    const clipboard = new DataTransfer();
    for (const [type, value] of Object.entries(data)) clipboard.setData(type, value);
    content.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }),
    );
  }, data);
}

async function save(page: Page) {
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

async function runCommand(page: Page, name: string) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox").fill(name);
  await expect(palette.getByRole("option").first()).toContainText(name);
  await palette.getByRole("combobox").press("Enter");
  await expect(palette).toBeHidden();
}

test("pasting rich text from a web page inserts Markdown", async ({ page }) => {
  await openDocument(page, "");
  await pasteData(page, {
    "text/html":
      '<meta charset="utf-8"><h2>Fruit</h2><p>From <a href="https://example.com">the shop</a>:</p>' +
      "<ul><li>Apple</li><li>Pear</li></ul>" +
      "<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apple</td><td>3</td></tr></table>" +
      '<pre><code class="language-sh">echo hi</code></pre>',
    "text/plain": "Fruit\nFrom the shop:\nApple\nPear\nName Qty\nApple 3\necho hi",
  });
  await save(page);
  expect(await readFile(page, path)).toBe(
    "## Fruit\n\nFrom [the shop](https://example.com):\n\n- Apple\n- Pear\n\n" +
      "| Name  | Qty |\n| ----- | --- |\n| Apple | 3   |\n\n```sh\necho hi\n```\n",
  );
});

test("Paste as Plain Text (⌘⇧V) inserts the clipboard text unchanged", async ({ page }) => {
  await openDocument(page, "", { clipboardText: "<b>*not* converted</b>" });
  await page.keyboard.press("ControlOrMeta+Shift+V");
  await expect(page.locator(".cm-content")).toBeFocused();
  await save(page);
  expect(await readFile(page, path)).toBe("<b>*not* converted</b>");
});

test("Paste as Plain Text reports a clipboard without text instead of doing nothing", async ({
  page,
}) => {
  await openDocument(page, "", { clipboardText: null });
  await page.keyboard.press("ControlOrMeta+Shift+V");
  await expect(page.getByRole("alert")).toContainText(
    "Could not paste as plain text: The clipboard holds no text",
  );
});

test("Vim key bindings are switched on and off from the command palette and kept in settings.json", async ({
  page,
}) => {
  await openDocument(page, "abc\n");
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await runCommand(page, "Toggle Vim Mode");
  await expect
    .poll(async () => JSON.parse((await readFile(page, settingsPath)) ?? "{}"))
    .toEqual({ vimMode: true });

  await page.keyboard.press("x");
  await expect(page.locator(".cm-content")).toHaveText("bc");

  await runCommand(page, "Toggle Vim Mode");
  await expect
    .poll(async () => JSON.parse((await readFile(page, settingsPath)) ?? "{}"))
    .toEqual({ vimMode: false });
  await page.keyboard.press("x");
  await expect(page.locator(".cm-content")).toHaveText("xbc");
});

test("Vim key bindings follow settings.json at startup", async ({ page }) => {
  await openDocument(page, "abc\n", { files: { [settingsPath]: '{ "vimMode": true }' } });
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await page.keyboard.press("x");
  await expect(page.locator(".cm-content")).toHaveText("bc");
});

test("system spellchecking is on by default and switched off in the settings window", async ({
  page,
}) => {
  await openDocument(page, "Some txet\n");
  await expect(page.locator(".cm-content")).toHaveAttribute("spellcheck", "true");

  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("Check spelling").uncheck();
  await expect(page.locator(".cm-content")).toHaveAttribute("spellcheck", "false");
  expect(JSON.parse((await readFile(page, settingsPath)) ?? "")).toEqual({ spellcheck: false });

  await page.keyboard.press("Escape");
  await runCommand(page, "Toggle Spellcheck");
  await expect(page.locator(".cm-content")).toHaveAttribute("spellcheck", "true");
});
