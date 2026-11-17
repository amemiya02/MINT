import { expect, type Page, test } from "@playwright/test";
import { launch, menu, readFile, settingsPath, writeFile } from "./memory-platform.ts";

const doc = "/notes/doc.md";
const settingsDialog = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const shortcutRow = (page: Page, command: string) =>
  settingsDialog(page).getByRole("group", { name: command, exact: true });
const mac = process.platform === "darwin";

async function openDocument(page: Page, text: string, settings?: string) {
  await launch(page, {
    files: { [doc]: text, ...(settings ? { [settingsPath]: settings } : {}) },
    openDialogResults: [doc],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeFocused();
}

async function savedSettings(page: Page): Promise<unknown> {
  return JSON.parse((await readFile(page, settingsPath)) ?? "{}");
}

async function boldWithSelection(page: Page, shortcut: string) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+/"); // source mode: what is typed is what is saved
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press(shortcut);
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
}

test("a shortcut recorded in the settings window is saved in settings.json and works at once", async ({
  page,
}) => {
  await openDocument(page, "word\n");
  await page.keyboard.press("ControlOrMeta+,");

  const bold = shortcutRow(page, "Bold");
  await expect(bold).toContainText(mac ? "⌘B" : "Ctrl+B");
  await bold.getByRole("button", { name: "Record" }).click();
  await expect(bold).toContainText("Press the new shortcut");
  await page.keyboard.press("ControlOrMeta+Shift+J");
  await expect(bold).toContainText(mac ? "⇧⌘J" : "Ctrl+Shift+J");

  expect(await savedSettings(page)).toEqual({
    shortcuts: { "format.bold": "CmdOrCtrl+Shift+J" },
  });
  const items = (await menu(page)).flatMap((m) => m.items);
  expect(items.find((i) => i.id === "format.bold")?.accelerator).toBe("CmdOrCtrl+Shift+J");

  await page.keyboard.press("Escape");
  await boldWithSelection(page, "ControlOrMeta+Shift+J");
  expect(await readFile(page, doc)).toBe("**word**\n");
});

test("while recording, the pressed keys do not run the command they belong to", async ({
  page,
}) => {
  await openDocument(page, "word\n");
  await page.keyboard.press("ControlOrMeta+,");

  const italic = shortcutRow(page, "Italic");
  await italic.getByRole("button", { name: "Record" }).click();
  // ⌘⇧P opens the command palette; recording it must not.
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(italic.getByRole("alert")).toContainText("Command Palette");
  await expect(page.getByRole("dialog", { name: "Command Palette" })).toHaveCount(0);
  await expect(settingsDialog(page)).toBeVisible();
});

test("on Windows and Linux a shortcut recorded with Ctrl is saved as ⌘-or-Ctrl", async ({
  page,
}) => {
  await page.context().addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" });
  });
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("Control+,");

  const bold = shortcutRow(page, "Bold");
  await expect(bold).toContainText("Ctrl+B");
  await bold.getByRole("button", { name: "Record" }).click();
  await page.keyboard.press("Control+Alt+B");
  await expect(bold).toContainText("Ctrl+Alt+B");
  expect(await savedSettings(page)).toEqual({ shortcuts: { "format.bold": "CmdOrCtrl+Alt+B" } });
});

test("Escape cancels recording and keeps the shortcut", async ({ page }) => {
  await openDocument(page, "word\n");
  await page.keyboard.press("ControlOrMeta+,");

  const bold = shortcutRow(page, "Bold");
  await bold.getByRole("button", { name: "Record" }).click();
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toBeVisible();
  await expect(bold).toContainText(mac ? "⌘B" : "Ctrl+B");
  expect(await readFile(page, settingsPath)).toBeUndefined();
});

test("a conflicting shortcut names the command that has it, and can replace it", async ({
  page,
}) => {
  await openDocument(page, "word\n");
  await page.keyboard.press("ControlOrMeta+,");

  const bold = shortcutRow(page, "Bold");
  await bold.getByRole("button", { name: "Record" }).click();
  await page.keyboard.press("ControlOrMeta+I");

  const conflict = bold.getByRole("alert");
  await expect(conflict).toContainText(mac ? "⌘I" : "Ctrl+I");
  await expect(conflict).toContainText("Italic");
  expect(await readFile(page, settingsPath)).toBeUndefined();

  await conflict.getByRole("button", { name: "Use Anyway" }).click();
  await expect(bold).toContainText(mac ? "⌘I" : "Ctrl+I");
  await expect(shortcutRow(page, "Italic")).toContainText("None");
  expect(await savedSettings(page)).toEqual({
    shortcuts: { "format.bold": "CmdOrCtrl+I", "format.italic": null },
  });

  await page.keyboard.press("Escape");
  await boldWithSelection(page, "ControlOrMeta+I");
  expect(await readFile(page, doc)).toBe("**word**\n");
});

test("cancelling a conflict changes nothing", async ({ page }) => {
  await openDocument(page, "word\n");
  await page.keyboard.press("ControlOrMeta+,");

  const bold = shortcutRow(page, "Bold");
  await bold.getByRole("button", { name: "Record" }).click();
  await page.keyboard.press("ControlOrMeta+I");
  await bold.getByRole("alert").getByRole("button", { name: "Cancel" }).click();

  await expect(bold.getByRole("alert")).toHaveCount(0);
  await expect(bold).toContainText(mac ? "⌘B" : "Ctrl+B");
  await expect(shortcutRow(page, "Italic")).toContainText(mac ? "⌘I" : "Ctrl+I");
  expect(await readFile(page, settingsPath)).toBeUndefined();
});

test("conflicts written into settings.json by hand are shown on both commands", async ({
  page,
}) => {
  await openDocument(page, "word\n", '{ "shortcuts": { "format.bold": "CmdOrCtrl+I" } }');
  await page.keyboard.press("ControlOrMeta+,");

  await expect(shortcutRow(page, "Bold")).toContainText("Also used by Italic");
  await expect(shortcutRow(page, "Italic")).toContainText("Also used by Bold");
});

test("an override can be removed or reset to the default", async ({ page }) => {
  await openDocument(page, "word\n", '{ "shortcuts": { "format.bold": "CmdOrCtrl+Shift+J" } }');
  await page.keyboard.press("ControlOrMeta+,");

  const bold = shortcutRow(page, "Bold");
  await expect(bold).toContainText(mac ? "⇧⌘J" : "Ctrl+Shift+J");
  await bold.getByRole("button", { name: "Reset" }).click();
  await expect(bold).toContainText(mac ? "⌘B" : "Ctrl+B");
  expect(await savedSettings(page)).toEqual({ shortcuts: {} });

  await bold.getByRole("button", { name: "Remove" }).click();
  await expect(bold).toContainText("None");
  expect(await savedSettings(page)).toEqual({ shortcuts: { "format.bold": null } });
  const items = (await menu(page)).flatMap((m) => m.items);
  expect(items.find((i) => i.id === "format.bold")?.accelerator).toBeNull();
});

test("editing shortcuts in settings.json takes effect immediately, in the palette too", async ({
  page,
}) => {
  await openDocument(page, "word\n");

  await writeFile(page, settingsPath, '{ "shortcuts": { "format.bold": "CmdOrCtrl+Shift+J" } }');
  await expect
    .poll(async () =>
      (await menu(page)).flatMap((m) => m.items).find((i) => i.id === "format.bold"),
    )
    .toMatchObject({ accelerator: "CmdOrCtrl+Shift+J" });

  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox").fill("bold");
  await expect(palette.getByRole("option").first()).toContainText(mac ? "⇧⌘J" : "Ctrl+Shift+J");
  await page.keyboard.press("Escape");

  await boldWithSelection(page, "ControlOrMeta+Shift+J");
  expect(await readFile(page, doc)).toBe("**word**\n");
});

test("an unknown command or a malformed shortcut in settings.json is reported", async ({
  page,
}) => {
  await openDocument(page, "word\n", '{ "shortcuts": { "format.bold": "Cmd+Banana+" } }');

  await expect(page.getByRole("alert")).toContainText("shortcuts");
  // The defaults stay in use.
  const items = (await menu(page)).flatMap((m) => m.items);
  expect(items.find((i) => i.id === "format.bold")?.accelerator).toBe("CmdOrCtrl+B");
});
