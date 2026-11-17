import { expect, test } from "@playwright/test";
import { launch, openedUrls, readFile } from "./memory-platform.ts";

test("renders inline spans and ⌘/ switches to source mode without moving the cursor", async ({
  page,
}) => {
  const path = "/notes/style.md";
  await launch(page, {
    files: { [path]: "Some **bold** text\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");

  const line = page.locator(".cm-line").first();
  await expect(line).toHaveText("Some bold text");

  await page.keyboard.press("ControlOrMeta+/");
  await expect(line).toHaveText("Some **bold** text");
  await expect(page.getByText("Source Mode")).toBeVisible();

  await page.keyboard.type("X");
  await page.keyboard.press("ControlOrMeta+/");
  await expect(line).toHaveText("XSome bold text");
  await expect(page.getByText("Live Preview")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe("XSome **bold** text\n");
});

test("⌘-click opens external links in the browser and local documents in MINT", async ({
  page,
}) => {
  const path = "/notes/index.md";
  await launch(page, {
    files: {
      [path]: "Go: [next](sub/next.md) or [site](https://example.com/)\n",
      "/notes/sub/next.md": "# Next page\n",
    },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");

  await page.getByText("site", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => openedUrls(page)).toEqual(["https://example.com/"]);

  await page.getByText("next", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveTitle("next.md — MINT");
  await expect(page.getByRole("textbox")).toContainText("Next page");
});

test("a find match inside hidden markers reveals them while it is selected", async ({ page }) => {
  const path = "/notes/find.md";
  await launch(page, {
    files: { [path]: "plain\n\nA **cat** here\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const line = page.locator(".cm-line").nth(2);
  await expect(line).toHaveText("A cat here");

  await page.keyboard.press("ControlOrMeta+F");
  const find = page.getByRole("textbox", { name: "Find" });
  await find.fill("cat");
  await find.press("Enter");
  await expect(page.getByText("1 of 1")).toBeVisible();
  await expect(line).toHaveText("A **cat** here");
  await expect(line.locator(".mint-find-match-current")).toHaveText("cat");

  await find.press("Escape");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(line).toHaveText("A cat here");
});
