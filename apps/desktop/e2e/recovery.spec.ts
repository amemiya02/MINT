import { expect, type Page, test } from "@playwright/test";
import {
  files as allFiles,
  launch,
  questionsAsked,
  readFile,
  recoveryDir,
  settingsPath,
} from "./memory-platform.ts";

const path = "/notes/draft.md";
// Autosave is off so the edits stay unsaved until the "crash".
const seed = { [path]: "# Draft\n", [settingsPath]: '{ "autosave": false }' };

/** Open the draft, type into it, and wait until the unsaved text is in the recovery area. */
async function typeUnsavedWork(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Draft");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
  await expect.poll(() => recoveryFiles(page), { timeout: 5000 }).not.toEqual({});
}

async function recoveryFiles(page: Page): Promise<Record<string, string>> {
  const entries = Object.entries(await allFiles(page));
  return Object.fromEntries(entries.filter(([p]) => p.startsWith(`${recoveryDir}/`)));
}

test("unsaved work is kept in the recovery area, outside the working folder", async ({ page }) => {
  await launch(page, { files: seed, openDialogResults: [path], locale: "en-US" });
  await typeUnsavedWork(page, "unsaved");

  const paths = Object.keys(await allFiles(page));
  expect(paths.filter((p) => p.startsWith("/notes/"))).toEqual([path]);
  expect(await readFile(page, path)).toBe("# Draft\n");
  expect(JSON.stringify(await recoveryFiles(page))).toContain("unsaved");
});

test("after a crash, the next start offers to restore the unsaved work", async ({
  page,
  browser,
}) => {
  await launch(page, { files: seed, openDialogResults: [path], locale: "en-US" });
  await typeUnsavedWork(page, "precious words");
  const leftOver = await recoveryFiles(page);
  // Crash: the window disappears without closing its tabs.
  await page.close();

  const next = await browser.newPage();
  await launch(next, {
    files: { ...seed, ...leftOver },
    questionDialogResults: ["yes"],
    locale: "en-US",
  });

  await expect(next.getByRole("textbox")).toContainText("# Draftprecious words");
  await expect(next.getByRole("tab", { name: "draft.md" })).toBeVisible();
  await expect(next.getByText("Unsaved changes")).toBeVisible();
  const questions = await questionsAsked(next);
  expect(questions).toHaveLength(1);
  expect(questions[0]).toContain("draft.md");

  // The restored text is ordinary unsaved work: saving writes it, and the snapshot goes away.
  await next.keyboard.press("ControlOrMeta+S");
  await expect(next.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(next, path)).toBe("# Draft\nprecious words");
  await expect.poll(() => recoveryFiles(next)).toEqual({});
});

test("the unsaved work can be discarded instead of restored", async ({ page, browser }) => {
  await launch(page, { files: seed, openDialogResults: [path], locale: "en-US" });
  await typeUnsavedWork(page, "throwaway");
  const leftOver = await recoveryFiles(page);
  await page.close();

  const next = await browser.newPage();
  await launch(next, {
    files: { ...seed, ...leftOver },
    questionDialogResults: ["no"],
    locale: "en-US",
  });

  await expect.poll(() => questionsAsked(next)).toHaveLength(1);
  await expect(next.getByText("No document open")).toBeVisible();
  await expect.poll(() => recoveryFiles(next)).toEqual({});
  expect(await readFile(next, path)).toBe("# Draft\n");
});

test("saving or closing a document clears its recovery snapshot", async ({ page }) => {
  await launch(page, {
    files: seed,
    openDialogResults: [path, path],
    questionDialogResults: ["no"],
    locale: "en-US",
  });
  await typeUnsavedWork(page, "a");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => recoveryFiles(page)).toEqual({});

  await page.keyboard.type("b");
  await expect.poll(() => recoveryFiles(page), { timeout: 5000 }).not.toEqual({});
  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.getByText("No document open")).toBeVisible();
  await expect.poll(() => recoveryFiles(page)).toEqual({});
});
