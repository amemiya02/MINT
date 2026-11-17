import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

test("typing `## ` turns the line into a heading, Enter continues lists, a click checks a task", async ({
  page,
}) => {
  const path = "/notes/plan.md";
  await launch(page, {
    files: { [path]: "Plan\n\n- [ ] write\n\n```js\nconst x = 1;\n```\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const lines = page.locator(".cm-line");

  await page.keyboard.type("## ");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("## Plan");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Plan");

  // Language label in place of the fences while the cursor is outside the block.
  await expect(lines.nth(4)).toHaveText("js");
  // The JavaScript grammar loads on demand and highlights the keyword.
  await expect(lines.nth(5).locator("span[class]", { hasText: /^const$/ })).toHaveCount(1);

  await page.getByRole("checkbox").click();
  await expect(page.getByRole("checkbox")).toBeChecked();

  await lines.nth(2).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("test");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(
    "## Plan\n\n- [x] write\n- [ ] test\n\n\n```js\nconst x = 1;\n```\n",
  );
});
