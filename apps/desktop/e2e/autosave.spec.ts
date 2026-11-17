import { expect, test } from "@playwright/test";
import { externalWrite, launch, readFile, settingsPath } from "./memory-platform.ts";

const path = "/notes/draft.md";

test("a document is saved automatically about a second after typing stops", async ({ page }) => {
  await launch(page, {
    files: { [path]: "# Draft\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Draft");

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("more");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  expect(await readFile(page, path)).toBe("# Draft\n");

  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 3000 });
  expect(await readFile(page, path)).toBe("# Draft\nmore");
});

test("autosave can be turned off in settings, leaving saving to the save command", async ({
  page,
}) => {
  await launch(page, {
    files: { [path]: "# Draft\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+,");
  const toggle = page.getByLabel("Save automatically");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect
    .poll(async () => JSON.parse((await readFile(page, settingsPath)) ?? "null"))
    .toEqual({ autosave: false });
  await page.getByRole("button", { name: "Close" }).click();

  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Draft");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("more");

  await page.waitForTimeout(2000);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  expect(await readFile(page, path)).toBe("# Draft\n");

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe("# Draft\nmore");
});

test("autosave leaves a conflict with another program's change for the user to settle", async ({
  page,
}) => {
  await launch(page, {
    files: { [path]: "# Draft\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Draft");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("mine");
  await externalWrite(page, path, "# Draft\ntheirs\n");
  await expect(page.getByText("was changed by another program")).toBeVisible();

  await page.waitForTimeout(2000);
  expect(await readFile(page, path)).toBe("# Draft\ntheirs\n");
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
});

test("autosaves of MINT itself are not mistaken for changes by another program", async ({
  page,
}) => {
  await launch(page, {
    files: { [path]: "# Draft\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Draft");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("one");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 3000 });
  await page.keyboard.type(" two");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 3000 });
  expect(await readFile(page, path)).toBe("# Draft\none two");
  await expect(page.getByText("was changed by another program")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toContainText("one two");
});
