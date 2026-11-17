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
