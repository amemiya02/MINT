import { expect, type Page, test } from "@playwright/test";
import {
  externalRemove,
  externalRename,
  externalWrite,
  launch,
  questionsAsked,
  readFile,
} from "./memory-platform.ts";

const path = "/notes/draft.md";

async function openDraft(page: Page, text: string) {
  await launch(page, {
    files: { [path]: text },
    directories: ["/notes"],
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText(text.trim().split("\n")[0] ?? "");
}

test("a document without local changes reloads silently and keeps the cursor", async ({ page }) => {
  await openDraft(page, "one\ntwo\n");
  // Put the cursor after "two".
  await page.getByText("two").click();
  await page.keyboard.press("End");

  await externalWrite(page, path, "zero\none\ntwo\n");

  const editor = page.getByRole("textbox");
  await expect(editor).toContainText("zero");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Typing continues where the cursor was, after "two".
  await page.keyboard.type("!");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe("zero\none\ntwo!\n");
});

test("MINT's own saves are not taken for external changes", async ({ page }) => {
  await openDraft(page, "# Draft\n");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("first");
  await page.keyboard.press("ControlOrMeta+S");
  await page.keyboard.type(" second");
  // Give the watcher time to report the save.
  await page.waitForTimeout(300);

  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toContainText("first second");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});

test.describe("a document with local changes", () => {
  async function conflict(page: Page) {
    await openDraft(page, "# Draft\n");
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("mine");
    await externalWrite(page, path, "# Draft\ntheirs\n");
    const notice = page.getByRole("alert");
    await expect(notice).toContainText("draft.md was changed by another program");
    return notice;
  }

  test("keeps the local text when the user chooses to", async ({ page }) => {
    const notice = await conflict(page);
    await expect(page.getByRole("textbox")).toContainText("mine");

    await notice.getByRole("button", { name: "Keep My Changes" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Unsaved changes")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+S");
    await expect.poll(() => readFile(page, path)).toBe("# Draft\nmine");
    expect(await questionsAsked(page)).toEqual([]);
  });

  test("loads the text from disk when the user chooses to", async ({ page }) => {
    const notice = await conflict(page);

    await notice.getByRole("button", { name: "Load from Disk" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("textbox")).toContainText("theirs");
    await expect(page.getByRole("textbox")).not.toContainText("mine");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  });

  test("shows the differences before the user decides", async ({ page }) => {
    const notice = await conflict(page);

    await notice.getByRole("button", { name: "Compare" }).click();
    const compare = page.getByRole("dialog", { name: "Compare with Disk" });
    await expect(compare.getByRole("deletion")).toHaveText(["- mine"]);
    await expect(compare.getByRole("insertion")).toHaveText(["+ theirs", "+ "]);

    await compare.getByRole("button", { name: "Load from Disk" }).click();
    await expect(compare).toHaveCount(0);
    await expect(page.getByRole("textbox")).toContainText("theirs");
  });

  test("is left alone when the disk already has the same text", async ({ page }) => {
    await openDraft(page, "# Draft\n");
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("same");
    await externalWrite(page, path, "# Draft\nsame");

    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test("tells the user when the document is deleted, and saving brings it back", async ({ page }) => {
  await openDraft(page, "# Draft\n");

  await externalRemove(page, path);

  const notice = page.getByRole("alert");
  await expect(notice).toContainText("draft.md was deleted or moved by another program");
  await expect(page.getByRole("textbox")).toContainText("# Draft");

  await notice.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await readFile(page, path)).toBe("# Draft\n");
});

test("tells the user when the document is renamed", async ({ page }) => {
  await openDraft(page, "# Draft\n");

  await externalRename(page, path, "/notes/final.md");

  await expect(page.getByRole("alert")).toContainText(
    "draft.md was deleted or moved by another program",
  );
  // Closing the tab now would lose the text, so MINT asks first.
  await expect(page.getByText("Unsaved changes")).toBeVisible();
});

test("renaming the document in the file tree is not reported, and the tab keeps watching it", async ({
  page,
}) => {
  await launch(page, {
    files: { [path]: "# Draft\n" },
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.getByRole("treeitem", { name: "draft.md", exact: true }).click();
  await expect(page.getByRole("main").getByRole("textbox")).toContainText("# Draft");

  await page.getByRole("treeitem", { name: "draft.md", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill("final.md");
  await name.press("Enter");
  await expect(page).toHaveTitle("final.md — MINT");
  await page.waitForTimeout(300);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await externalWrite(page, "/notes/final.md", "# Final\n");
  await expect(page.getByRole("main").getByRole("textbox")).toContainText("# Final");
});

test("a document that cannot be watched says changes on disk will go unnoticed", async ({
  page,
}) => {
  await launch(page, {
    files: { [path]: "text\n" },
    openDialogResults: [path],
    unwatchablePaths: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");

  await expect(page.getByRole("textbox")).toContainText("text");
  await expect(page.getByRole("alert")).toContainText(
    "Changes other programs make to /notes/draft.md will not be detected: too many open files",
  );
});
