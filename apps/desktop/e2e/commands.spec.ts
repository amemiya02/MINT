import { expect, type Page, test } from "@playwright/test";
import { launch, menu, readFile } from "./memory-platform.ts";

const palette = (page: Page) => page.getByRole("dialog", { name: "Command Palette" });
const search = (page: Page) => palette(page).getByRole("combobox");
const results = (page: Page) => palette(page).getByRole("option");

async function openDocument(page: Page, text: string, locale = "en-US", primary = "ControlOrMeta") {
  const path = "/notes/doc.md";
  await launch(page, { files: { [path]: text }, openDialogResults: [path], locale });
  await page.keyboard.press(`${primary}+O`);
  await expect(page.locator(".cm-content")).toBeFocused();
  return path;
}

/** Pretend to be a browser on Windows, before the shell loads. */
async function onWindows(page: Page) {
  await page.context().addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" });
  });
}

test("⌘⇧P fuzzy-searches commands by name, shows their shortcuts and runs the chosen one", async ({
  page,
}) => {
  await openDocument(page, "Some **bold** text\n");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(search(page)).toBeFocused();

  await search(page).fill("tglsrc");
  await expect(results(page)).toHaveCount(1);
  await expect(results(page).first()).toContainText("Toggle Source Mode");
  const shortcut = process.platform === "darwin" ? "⌘/" : "Ctrl+/";
  await expect(results(page).first()).toContainText(shortcut);

  await search(page).press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(page.getByText("Source Mode")).toBeVisible();
  await expect(page.locator(".cm-content")).toBeFocused();
});

test("Escape closes the palette without running anything", async ({ page }) => {
  await openDocument(page, "text\n");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await search(page).fill("source");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  await expect(page.getByText("Live Preview")).toBeVisible();
});

test("runs editor commands from the palette on the active document", async ({ page }) => {
  const path = await openDocument(page, "Title\n");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await search(page).fill("heading 3");
  await expect(results(page).first()).toContainText("Heading 3");
  await search(page).press("Enter");
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe("### Title\n");
});

test("Typora's default shortcuts format the document", async ({ page }) => {
  const path = await openDocument(page, "Title\n\nword\n");
  await page.keyboard.press("ControlOrMeta+/"); // source mode: what is typed is what is saved

  await page.keyboard.press("ControlOrMeta+2");
  await page.keyboard.press("ControlOrMeta+6");
  await page.keyboard.press("ControlOrMeta+0");
  await page.keyboard.press("ControlOrMeta+1");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("ControlOrMeta+B");
  await page.keyboard.press("ControlOrMeta+I");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type("x");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await page.keyboard.type("code");

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe("# Title\n\n***word***[x]()\n\n```\ncode\n```\n");
});

test("on Windows and Linux ⌘ becomes Ctrl", async ({ page }) => {
  await onWindows(page);
  const path = await openDocument(page, "word\n", "en-US", "Control");
  await page.keyboard.press("Control+Shift+P");
  await search(page).fill("bold");
  await expect(results(page).first()).toContainText("Ctrl+B");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Control+B");
  await page.keyboard.press("Control+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe("**word**\n");
});

test("the native menu, the palette and the shortcuts come from one registry", async ({ page }) => {
  await openDocument(page, "text\n");
  const items = (await menu(page)).flatMap((m) => m.items);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(results(page).first()).toBeVisible();
  const listed = await results(page).evaluateAll((options) =>
    options.map((o) => ({
      id: o.getAttribute("data-command"),
      shortcut: o.getAttribute("aria-keyshortcuts"),
    })),
  );

  // Every palette command is in the menu, with the same shortcut, and vice versa.
  // The palette leaves out only itself.
  const runnable = items.filter((i) => i.id !== "view.commandPalette");
  expect(listed.map((c) => c.id).sort()).toEqual(runnable.map((i) => i.id).sort());
  for (const item of runnable) {
    const entry = listed.find((c) => c.id === item.id);
    expect(entry?.shortcut ?? null, item.id).toEqual(item.accelerator ? expect.any(String) : null);
  }
  expect(items.find((i) => i.id === "format.bold")?.accelerator).toBe("CmdOrCtrl+B");
  expect(items.find((i) => i.id === "paragraph.heading1")?.accelerator).toBe("CmdOrCtrl+1");
});

test("command names follow the UI language", async ({ page }) => {
  await openDocument(page, "text\n", "zh-CN");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
  await page.getByRole("combobox").fill("加粗");
  await expect(page.getByRole("option").first()).toContainText("加粗");
});
