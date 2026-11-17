import { expect, test } from "@playwright/test";
import { launch, questionsAsked, readFile } from "./memory-platform.ts";

const files = { "/notes/a.md": "# Alpha\n", "/notes/b.md": "# Beta\n" };

test("open several documents in tabs and switch between them", async ({ page }) => {
  await launch(page, { files, openDialogResults: ["/notes/a.md", "/notes/b.md"], locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Beta");

  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveTitle("b.md — MINT");

  await page.getByRole("tab", { name: "a.md" }).click();
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await expect(page).toHaveTitle("a.md — MINT");
});

test("switch tabs from the keyboard", async ({ page }) => {
  await launch(page, { files, openDialogResults: ["/notes/a.md", "/notes/b.md"], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Beta");

  await page.keyboard.press("Control+Tab");
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+Shift+Tab");
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true");
});

test("opening a document that is already open focuses its tab", async ({ page }) => {
  await launch(page, {
    files,
    openDialogResults: ["/notes/a.md", "/notes/b.md", "/notes/a.md"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.type("edited ");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Beta");

  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab")).toHaveCount(2);
  // The existing tab, with its unsaved edit, not a fresh copy from disk.
  await expect(page.getByRole("textbox")).toContainText("edited # Alpha");
});

test("closing a tab with unsaved changes asks first; cancel keeps it, don't save discards", async ({
  page,
}) => {
  await launch(page, {
    files,
    openDialogResults: ["/notes/a.md"],
    questionDialogResults: ["cancel", "no"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.type("draft ");

  await page.getByRole("button", { name: "Close a.md" }).click();
  await expect.poll(() => questionsAsked(page)).toHaveLength(1);
  expect((await questionsAsked(page))[0]).toContain("a.md");
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("No document open")).toBeVisible();
  expect(await readFile(page, "/notes/a.md")).toBe("# Alpha\n");
});

test("closing a tab with unsaved changes can save them", async ({ page }) => {
  await launch(page, {
    files,
    openDialogResults: ["/notes/a.md"],
    questionDialogResults: ["yes"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.type("draft ");

  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.getByRole("tab")).toHaveCount(0);
  expect(await readFile(page, "/notes/a.md")).toBe("draft # Alpha\n");
});

test("closing a saved tab does not ask and shows the neighbouring tab", async ({ page }) => {
  await launch(page, { files, openDialogResults: ["/notes/a.md", "/notes/b.md"], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Beta");

  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  expect(await questionsAsked(page)).toEqual([]);
});

test("closing a window with unsaved changes asks first and can be cancelled", async ({ page }) => {
  await launch(page, {
    files,
    openDialogResults: ["/notes/a.md"],
    questionDialogResults: ["cancel"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.type("draft ");

  const closed = await page.evaluate(async () => {
    const platform = (
      window as unknown as {
        __MINT_MEMORY_PLATFORM__: { closeWindow(): Promise<void>; closed: boolean };
      }
    ).__MINT_MEMORY_PLATFORM__;
    await platform.closeWindow();
    return platform.closed;
  });
  expect(closed).toBe(false);
  expect(await questionsAsked(page)).toHaveLength(1);
  await expect(page.getByRole("textbox")).toContainText("draft # Alpha");
});

test("a new window has its own independent tabs", async ({ page }) => {
  await launch(page, { files, openDialogResults: ["/notes/a.md", "/notes/b.md"], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible();

  const [second] = await Promise.all([
    page.waitForEvent("popup"),
    page.keyboard.press("ControlOrMeta+Shift+N"),
  ]);
  await expect(second.getByText("No document open")).toBeVisible();
  await expect(second).toHaveTitle("MINT");

  await second.getByRole("button", { name: "Open Document…" }).click();
  await expect(second.getByRole("tab", { name: "a.md" })).toBeVisible();
  await second.keyboard.press("ControlOrMeta+W");
  await expect(second.getByRole("tab")).toHaveCount(0);

  // The first window is untouched by what happened in the second.
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveTitle("a.md — MINT");
});
