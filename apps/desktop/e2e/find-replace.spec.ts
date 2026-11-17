import { expect, type Page, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

const files = {
  "/notes/a.md": "The cat sat.\nA **cat** and a Cat.\nconcat\n",
  "/notes/b.md": "dog\n",
};
const replaceShortcut = process.platform === "darwin" ? "Meta+Alt+F" : "Control+H";

async function openA(page: Page, locale = "en-US") {
  await launch(page, { files, openDialogResults: ["/notes/a.md"], locale });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox").first()).toContainText("The cat sat.");
}

test("find with ⌘F steps through matches, including one inside bold markers", async ({ page }) => {
  await openA(page);
  await page.keyboard.press("ControlOrMeta+F");
  const find = page.getByRole("textbox", { name: "Find" });
  await expect(find).toBeFocused();
  await find.fill("cat");
  await expect(page.getByText("1 of 4")).toBeVisible();
  await find.press("Enter");
  await expect(page.getByText("2 of 4")).toBeVisible();

  await page.getByRole("button", { name: "Match Whole Word" }).click();
  await expect(page.getByText(/of 3/)).toBeVisible();
  await page.getByRole("button", { name: "Match Case" }).click();
  await expect(page.getByText(/of 2/)).toBeVisible();

  await find.press("Escape");
  await expect(find).toBeHidden();
  await expect(page.getByRole("textbox")).toBeFocused();
});

test("regular expressions, with a clear message when the pattern is invalid", async ({ page }) => {
  await openA(page);
  await page.keyboard.press("ControlOrMeta+F");
  await page.getByRole("button", { name: "Use Regular Expression" }).click();
  const find = page.getByRole("textbox", { name: "Find" });
  await find.fill("c[a-z]t");
  await expect(page.getByText(/of 4/)).toBeVisible();
  await find.fill("(");
  await expect(page.getByText("Invalid regular expression")).toBeVisible();
});

test("replace all with the replace shortcut, then undo it in one step", async ({ page }) => {
  await openA(page);
  await page.keyboard.press(replaceShortcut);
  await page.getByRole("textbox", { name: "Find" }).fill("cat");
  await page.getByRole("button", { name: "Match Whole Word" }).click();
  await page.getByRole("textbox", { name: "Replace with" }).fill("dog");
  await page.getByRole("button", { name: "Replace All" }).click();
  await expect(page.getByText("No results")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, "/notes/a.md"))
    .toBe("The dog sat.\nA **dog** and a dog.\nconcat\n");

  await page.getByRole("textbox", { name: "Find" }).press("Escape");
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, "/notes/a.md")).toBe(files["/notes/a.md"]);
});

test("replace one match at a time", async ({ page }) => {
  await openA(page);
  await page.keyboard.press(replaceShortcut);
  await page.getByRole("textbox", { name: "Find" }).fill("cat");
  await page.getByRole("textbox", { name: "Replace with" }).fill("cow");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("The cow sat.");
  await expect(page.getByText("1 of 3")).toBeVisible();
});

test("the find bar follows the active tab", async ({ page }) => {
  await launch(page, { files, openDialogResults: ["/notes/a.md", "/notes/b.md"], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox").first()).toContainText("The cat sat.");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ControlOrMeta+F");
  await page.getByRole("textbox", { name: "Find" }).fill("cat");
  await expect(page.getByText("No results")).toBeVisible();
  await page.getByRole("tab", { name: "a.md" }).click();
  await expect(page.getByText(/of 4/)).toBeVisible();
});

test("the find bar is translated", async ({ page }) => {
  await openA(page, "zh-CN");
  await page.keyboard.press("ControlOrMeta+F");
  await expect(page.getByRole("textbox", { name: "查找" })).toBeFocused();
  await expect(page.getByRole("button", { name: "区分大小写" })).toBeVisible();
});
