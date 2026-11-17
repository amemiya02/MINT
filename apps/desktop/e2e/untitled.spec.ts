import { expect, type Page, test } from "@playwright/test";
import {
  files as allFiles,
  launch,
  questionsAsked,
  readFile,
  recoveryDir,
  savedDialogs,
} from "./memory-platform.ts";

const editor = (page: Page) => page.getByRole("main").getByRole("textbox");

async function recoveryFiles(page: Page): Promise<Record<string, string>> {
  const entries = Object.entries(await allFiles(page));
  return Object.fromEntries(entries.filter(([p]) => p.startsWith(`${recoveryDir}/`)));
}

test("New (⌘N) opens an untitled document that the first save puts where the user says", async ({
  page,
}) => {
  await launch(page, {
    directories: ["/notes"],
    saveDialogResults: ["/notes/idea.md"],
    locale: "en-US",
  });

  await page.keyboard.press("ControlOrMeta+N");
  await expect(page.getByRole("tab", { name: "Untitled" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page).toHaveTitle("Untitled — MINT");
  await page.keyboard.press("ControlOrMeta+N");
  await expect(page.getByRole("tab", { name: "Untitled 2" })).toBeVisible();

  await page.keyboard.type("# Idea");
  await page.keyboard.press("ControlOrMeta+S");

  await expect(page.getByRole("tab", { name: "idea.md" })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, "/notes/idea.md")).toBe("# Idea");
  expect(await savedDialogs(page)).toEqual(["Untitled.md"]);
  // The other untitled document is untouched.
  await expect(page.getByRole("tab", { name: "Untitled", exact: true })).toBeVisible();
});

test("cancelling the save dialog keeps the untitled document unsaved", async ({ page }) => {
  await launch(page, { saveDialogResults: [null], locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+N");
  await page.keyboard.type("draft");
  await page.keyboard.press("ControlOrMeta+S");

  await expect.poll(() => savedDialogs(page)).toHaveLength(1);
  await expect(page.getByRole("tab", { name: "Untitled" })).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});

test("Save As (⌘⇧S) writes the document under a new name and the tab follows it", async ({
  page,
}) => {
  await launch(page, {
    files: { "/notes/a.md": "# A\n" },
    openDialogResults: ["/notes/a.md"],
    saveDialogResults: ["/notes/b.md"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(editor(page)).toContainText("# A");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("more");

  await page.keyboard.press("ControlOrMeta+Shift+S");

  await expect(page.getByRole("tab", { name: "b.md" })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await savedDialogs(page)).toEqual(["/notes/a.md"]);
  expect(await readFile(page, "/notes/b.md")).toBe("# A\nmore");
  expect(await readFile(page, "/notes/a.md")).toBe("# A\n");
});

test("autosave leaves untitled documents alone until they have a place on disk", async ({
  page,
}) => {
  await launch(page, { locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+N");
  await page.keyboard.type("not yet");
  await page.waitForTimeout(2000);

  expect(await savedDialogs(page)).toEqual([]);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});

test("unsaved untitled documents are recovered after a crash", async ({ page, browser }) => {
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+N");
  await page.keyboard.type("lost thoughts");
  await expect.poll(() => recoveryFiles(page), { timeout: 5000 }).not.toEqual({});
  const leftOver = await recoveryFiles(page);
  await page.close();

  const next = await browser.newPage();
  await launch(next, { files: leftOver, questionDialogResults: ["yes"], locale: "en-US" });

  await expect(editor(next)).toContainText("lost thoughts");
  await expect(next.getByRole("tab", { name: "Untitled" })).toBeVisible();
  const questions = await questionsAsked(next);
  expect(questions[0]).toContain("Untitled");
});
