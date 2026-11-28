import { expect, type Page, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

const path = "/draft.md";
const source = "Before  \n\nAfter";
async function install(page: Page, allow: boolean) {
  await expect(page.locator(".cm-content")).toContainText("After");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings
    .getByRole("group", { name: "Zotero" })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await expect(settings.getByText("Connect to the local Zotero library")).toBeVisible();
  await expect(settings.getByText("Modify the current document")).toBeVisible();
  await settings.getByRole("button", { name: allow ? "Allow access" : "Deny access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
}
test("the writer can cancel, then insert a selected Zotero reference at the caret", async ({
  page,
}) => {
  await launch(page, {
    locale: "en-US",
    files: { [path]: source },
    openedPaths: [{ kind: "file", path }],
    zoteroItems: [
      { key: "AAAA1111", title: "First reference" },
      { key: "BBBB2222", title: "Second reference" },
    ],
  });
  await install(page, true);
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Home");
  const open = page.getByRole("button", { name: "Insert Zotero citation" });
  await open.click();
  await expect(page.getByRole("button", { name: "Second reference" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await readFile(page, path)).toBe(source);
  await open.click();
  await page.getByRole("button", { name: "Second reference" }).click();
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(page, path))
    .toBe("Before  \n\n[Second reference](zotero://select/library/items/BBBB2222)After");
});
for (const allow of [false, true]) {
  test(
    allow
      ? "an unavailable Zotero service preserves the source"
      : "denying Zotero permissions preserves the source",
    async ({ page }) => {
      await launch(page, {
        locale: "en-US",
        files: { [path]: source },
        openedPaths: [{ kind: "file", path }],
      });
      await install(page, allow);
      await page.getByRole("button", { name: "Insert Zotero citation" }).click();
      await expect(page.getByRole("alert")).toContainText(
        allow ? "Could not read the library" : "Zotero access was denied",
      );
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.keyboard.press("ControlOrMeta+s");
      expect(await readFile(page, path)).toBe(source);
    },
  );
}
