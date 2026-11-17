import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

test("edits a table in place and saves only the edited cells", async ({ page }) => {
  const path = "/notes/fruit.md";
  const original = "# Fruit\n\n| Name | Qty |\n|:-----|----:|\n| 苹果 |   3 |\n\nend\n";
  await launch(page, {
    files: { [path]: original },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");

  const table = page.locator(".cm-mint-table");
  await expect(table.locator("[data-mint-cell]")).toHaveText(["Name", "Qty", "苹果", "3"]);

  // Click into the quantity cell, replace it, then Tab past the last cell to add a row.
  const qty = table.locator('[data-mint-cell="1:1"]');
  await qty.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("30");
  await page.keyboard.press("Tab");
  await expect(table.locator('[data-mint-cell="2:0"]')).toBeFocused();
  await page.keyboard.type("梨");
  await page.keyboard.press("Tab");
  await page.keyboard.type("7");

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(
    "# Fruit\n\n| Name | Qty |\n|:-----|----:|\n| 苹果 |   30 |\n| 梨   | 7   |\n\nend\n",
  );
});

test("the toolbar formats the table, labelled in the UI language", async ({ page }) => {
  const path = "/notes/t.md";
  await launch(page, {
    files: { [path]: "# T\n\n| a | bb |\n|-|-|\n| ccc | d |\n\nend\n" },
    openDialogResults: [path],
    locale: "zh-CN",
  });
  await page.keyboard.press("ControlOrMeta+O");

  await page.locator('[data-mint-cell="1:0"]').click();
  await page.getByRole("button", { name: "格式化表格" }).click();
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe("# T\n\n| a   | bb  |\n| --- | --- |\n| ccc | d   |\n\nend\n");
});
