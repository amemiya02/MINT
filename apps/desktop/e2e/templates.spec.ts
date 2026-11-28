import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

test("a template command edits only the selected range after the writer grants access", async ({
  page,
}) => {
  const path = "/notes/draft.md";
  const other = "/notes/other.md";
  const original = "\uFEFFTitle  \r\nreplace\r\n\r\n尾\r\n";
  await launch(page, {
    locale: "en-US",
    openDialogResults: [other, path],
    files: { [path]: original, [other]: "Another draft\n" },
  });
  for (const name of ["other.md", "draft.md"]) {
    await page.keyboard.press("ControlOrMeta+o");
    await expect(page).toHaveTitle(`${name} — MINT`);
  }
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await page.keyboard.press("ControlOrMeta+,");
  await settings.getByRole("button", { name: "Install writing templates" }).click();
  await expect(settings.getByText("Modify the current document at the selection")).toBeVisible();
  await settings.getByRole("button", { name: "Deny access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  async function chooseTemplate() {
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.getByRole("combobox").fill("meeting notes");
    await page.getByRole("option", { name: /Meeting notes/i }).click();
  }
  await chooseTemplate();
  await expect(page.getByRole("alert")).toContainText(
    "Permission to modify the current document was denied.",
  );
  await page.keyboard.press("ControlOrMeta+s");
  expect(await readFile(page, path)).toBe(original);
  await page.keyboard.press("ControlOrMeta+,");
  await settings.getByRole("button", { name: "Allow access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await chooseTemplate();
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(page, path))
    .toBe("\uFEFFTitle  \r\n## Meeting notes\r\n\r\n- \r\n\r\n尾\r\n");
  expect(await readFile(page, other)).toBe("Another draft\n");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(page, path)).toBe(original);
});
