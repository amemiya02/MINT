import { expect, type Page, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

async function openPanes(page: Page) {
  await launch(page, {
    files: {
      "/notes/draft.md": "Draft apple",
      "/notes/reference.md": "Reference pear",
      [settingsPath]: '{"autosave":false}',
    },
    openDialogResults: ["/notes/draft.md", "/notes/reference.md"],
    locale: "en-US",
  });
  const draft = page.getByRole("tabpanel", { name: "draft.md" });
  const reference = page.getByRole("tabpanel", { name: "reference.md" });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(draft.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+O");
  await expect(reference.getByRole("textbox")).toBeFocused();
  await page.getByRole("button", { name: "Open reference.md in other pane" }).click();
  await expect(draft).toBeVisible();
  return { draft, reference };
}

test("each pane formats its own selection and can undo the edit", async ({ page }) => {
  const { draft, reference } = await openPanes(page);
  const left = draft.getByRole("textbox");
  const right = reference.getByRole("textbox");
  await left.getByText("Draft apple").dblclick({ position: { x: 8, y: 8 } });
  await right.press("End");
  await right.press("Shift+Home");
  await draft.getByRole("toolbar").getByRole("button", { name: "Bold", exact: true }).click();
  await expect(left).toHaveText("**Draft** apple");
  await expect(right).toHaveText("Reference pear");
  await reference.getByRole("toolbar").getByRole("button", { name: "Italic", exact: true }).click();
  await expect(right).toHaveText("*Reference pear*");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(right).toHaveText("Reference pear");
  await expect(left).toHaveText("**Draft** apple");
  await left.press("ControlOrMeta+z");
  await expect(left).toHaveText("Draft apple");
});

async function runCommand(page: Page, name: string) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command Palette" });
  await palette.getByRole("combobox").fill(name);
  await expect(palette.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
}

test("move, hide and restore a pane's toolbar without losing the selected text", async ({
  page,
}) => {
  const { draft, reference } = await openPanes(page);
  const editor = reference.getByRole("textbox");
  const toolbar = reference.getByRole("toolbar");
  const surface = reference.locator(".cm-editor");
  await editor.press("End");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  await runCommand(page, "Show formatting toolbar on the side");
  const sideEdge = await toolbar.evaluate((bar) => bar.getBoundingClientRect().right);
  expect(sideEdge).toBeLessThanOrEqual(
    await surface.evaluate((el) => el.getBoundingClientRect().left),
  );
  await runCommand(page, "Hide formatting toolbar");
  await expect(toolbar).toHaveCount(0);
  await expect(draft.getByRole("toolbar")).toBeVisible();
  await expect(editor).toBeFocused();
  await runCommand(page, "Show formatting toolbar on top");
  const bottomEdge = await toolbar.evaluate((bar) => bar.getBoundingClientRect().bottom);
  expect(bottomEdge).toBeLessThanOrEqual(
    await surface.evaluate((el) => el.getBoundingClientRect().top),
  );
  await toolbar.getByRole("button", { name: "Bold" }).click();
  await expect(editor).toHaveText("Reference **pear**");
  await expect(draft.getByRole("textbox")).toHaveText("Draft apple");
});

test("keyboard focus identifies the target pane in light and dark themes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const { draft, reference } = await openPanes(page);
  const editor = reference.getByRole("textbox");
  await editor.press("End");
  await editor.press("Shift+Home");
  await runCommand(page, "Show formatting toolbar on the side");

  // Tab out of the left editor into the reference controls, leaving its selection intact.
  await draft.getByRole("textbox").press("Tab");
  const toolbar = reference.getByRole("toolbar");
  const bold = toolbar.getByRole("button", { name: "Bold" });
  await expect(bold).toBeFocused();
  await expect(toolbar).toHaveAccessibleName(/reference\.md.*right pane/i);
  await expect(page).toHaveTitle("reference.md — MINT");
  await expect(reference).toHaveCSS("outline-style", "solid");
  await expect(bold).toHaveCSS("outline-color", "rgb(9, 105, 218)");

  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("Theme", { exact: true }).selectOption({ label: "Bookleaf" });
  await page.getByLabel("Appearance").selectOption({ label: "Dark" });
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await draft.getByRole("textbox").press("Tab");
  await expect(bold).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const italic = toolbar.getByRole("button", { name: "Italic" });
  await expect(italic).toBeFocused();
  await expect(italic).toHaveCSS("outline-style", "solid");
  await expect(italic).toHaveCSS("outline-color", "rgb(237, 174, 143)");
  await expect(italic).toHaveCSS("color", "rgb(238, 224, 209)");
  await expect(reference).toHaveCSS("outline-color", "rgb(237, 174, 143)");
  await page.keyboard.press("Enter");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("*Reference pear*");
  await expect(draft.getByRole("textbox")).toHaveText("Draft apple");
});

test("toolbars for the same manuscript use each view's selection and share undo", async ({
  page,
}) => {
  const path = "/notes/manuscript.md";
  await launch(page, {
    files: { [path]: "Definition\n\nConclusion", [settingsPath]: '{"autosave":false}' },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const left = page.getByRole("textbox").first();
  await expect(left).toBeFocused();
  await left.press("Shift+End");
  await page.getByRole("button", { name: "Open manuscript.md in other pane" }).click();
  const right = page.getByRole("textbox").nth(1);
  await expect(right).toBeFocused();
  await right.press("ControlOrMeta+End");
  await right.press("Shift+Home");

  const leftBar = page.getByRole("toolbar", {
    name: "Formatting for manuscript.md in the left pane",
  });
  const rightBar = page.getByRole("toolbar", {
    name: "Formatting for manuscript.md in the right pane",
  });
  await leftBar.getByRole("button", { name: "Link" }).click();
  await page.keyboard.type("#term");
  await rightBar.getByRole("button", { name: "Bold" }).click();
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe("[Definition](#term)\n\n**Conclusion**");
  await left.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe("[Definition](#term)\n\nConclusion");
});
