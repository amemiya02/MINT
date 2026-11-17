import { expect, type Page, test } from "@playwright/test";
import {
  externalRemove,
  externalWrite,
  launch,
  listPaths,
  readAppData,
  readFile,
  trashed,
} from "./memory-platform.ts";

const folder = "/notes";
const files = {
  "/notes/todo.md": "# Todo\n",
  "/notes/ideas.markdown": "# Ideas\n",
  "/notes/photo.png": "not really a png",
  "/notes/.git/HEAD": "ref: refs/heads/main\n",
  "/notes/journal/2026.md": "# 2026\n",
  "/elsewhere/loose.md": "# Loose\n",
};

async function openFolder(page: Page) {
  await launch(page, { files, openFolderDialogResults: [folder], locale: "en-US" });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await expect(page.getByRole("tree", { name: "notes" })).toBeVisible();
}

const item = (page: Page, name: string) => page.getByRole("treeitem", { name, exact: true });
const editor = (page: Page) => page.getByRole("main").getByRole("textbox");

test("opening a folder shows its file tree, highlighting Markdown documents", async ({ page }) => {
  await openFolder(page);

  await expect(item(page, "todo.md")).toBeVisible();
  await expect(item(page, "ideas.markdown")).toBeVisible();
  await expect(item(page, "journal")).toHaveAttribute("aria-expanded", "false");
  // Other files are listed but not offered as documents; hidden entries are not listed.
  await expect(item(page, "photo.png")).toHaveAttribute("aria-disabled", "true");
  await expect(item(page, "todo.md")).not.toHaveAttribute("aria-disabled", "true");
  await expect(item(page, ".git")).toHaveCount(0);

  await item(page, "journal").click();
  await expect(item(page, "journal")).toHaveAttribute("aria-expanded", "true");
  await item(page, "2026.md").click();
  await expect(editor(page)).toContainText("# 2026");
  await expect(page).toHaveTitle("2026.md — MINT");
  await expect(item(page, "2026.md")).toHaveAttribute("aria-selected", "true");

  await item(page, "todo.md").click();
  await expect(editor(page)).toContainText("# Todo");
});

test("switching documents keeps the edits made to the previous one", async ({ page }) => {
  await openFolder(page);
  await item(page, "todo.md").click();
  const text = editor(page);
  await expect(text).toContainText("# Todo");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("- milk");

  await item(page, "ideas.markdown").click();
  await expect(text).toContainText("# Ideas");

  expect(await readFile(page, "/notes/todo.md")).toBe("# Todo\n- milk");
});

test("create, rename and delete documents and folders from the sidebar", async ({ page }) => {
  await openFolder(page);

  // New document in the folder root: it is created empty and opened.
  await page.getByRole("button", { name: "New Document" }).click();
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(name).toHaveValue("Untitled.md");
  await name.fill("draft");
  await name.press("Enter");
  await expect(item(page, "draft.md")).toBeVisible();
  expect(await readFile(page, "/notes/draft.md")).toBe("");
  await expect(page).toHaveTitle("draft.md — MINT");

  // New folder, then a document inside it via the context menu.
  await page.getByRole("button", { name: "New Folder" }).click();
  await name.fill("drafts");
  await name.press("Enter");
  await expect(item(page, "drafts")).toBeVisible();
  await item(page, "drafts").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New Document" }).click();
  await name.fill("inner.md");
  await name.press("Enter");
  await expect(item(page, "inner.md")).toBeVisible();
  expect(await readFile(page, "/notes/drafts/inner.md")).toBe("");

  // Rename a document that is open: the editor keeps it and saves to the new path.
  await item(page, "inner.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(name).toHaveValue("inner.md");
  await name.fill("final.md");
  await name.press("Enter");
  await expect(item(page, "final.md")).toBeVisible();
  await expect(item(page, "inner.md")).toHaveCount(0);
  await expect(page).toHaveTitle("final.md — MINT");
  await editor(page).click();
  await page.keyboard.type("Done");
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, "/notes/drafts/final.md")).toBe("Done");
  expect(await readFile(page, "/notes/drafts/inner.md")).toBeUndefined();

  // Rename a folder with F2.
  await item(page, "drafts").focus();
  await page.keyboard.press("F2");
  await name.fill("published");
  await name.press("Enter");
  await expect(item(page, "published")).toBeVisible();
  expect(await readFile(page, "/notes/published/final.md")).toBe("Done");

  // Delete moves to the system trash.
  await item(page, "todo.md").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(item(page, "todo.md")).toHaveCount(0);
  await item(page, "published").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(item(page, "published")).toHaveCount(0);
  expect(await trashed(page)).toEqual(["/notes/todo.md", "/notes/published"]);
  expect(await readFile(page, "/notes/published/final.md")).toBeUndefined();
});

test("a name that is already taken is reported and nothing is overwritten", async ({ page }) => {
  await openFolder(page);

  await item(page, "ideas.markdown").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill("todo.md");
  await name.press("Enter");

  await expect(page.getByRole("alert")).toContainText("todo.md");
  expect(await readFile(page, "/notes/todo.md")).toBe("# Todo\n");
  expect(await readFile(page, "/notes/ideas.markdown")).toBe("# Ideas\n");
});

test("the file tree follows changes made outside MINT", async ({ page }) => {
  await openFolder(page);
  await item(page, "journal").click();

  await externalWrite(page, "/notes/from-git.md", "# Pulled\n");
  await externalWrite(page, "/notes/journal/2027.md", "# 2027\n");
  await externalRemove(page, "/notes/todo.md");

  await expect(item(page, "from-git.md")).toBeVisible();
  await expect(item(page, "2027.md")).toBeVisible();
  await expect(item(page, "todo.md")).toHaveCount(0);
});

test("the sidebar can be hidden and shown again", async ({ page }) => {
  await openFolder(page);
  const tree = page.getByRole("tree", { name: "notes" });

  await page.keyboard.press("ControlOrMeta+Shift+L");
  await expect(tree).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await expect(tree).toBeVisible();
});

test("recently opened documents and folders are kept in the app data directory", async ({
  page,
}) => {
  await launch(page, {
    files,
    openFolderDialogResults: [folder],
    openDialogResults: ["/elsewhere/loose.md"],
    locale: "en-US",
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await item(page, "todo.md").click();
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page).toHaveTitle("loose.md — MINT");

  const stored = JSON.parse((await readAppData(page, "recent.json")) ?? "null");
  expect(stored).toEqual({
    documents: ["/elsewhere/loose.md", "/notes/todo.md"],
    folders: ["/notes"],
  });

  // A fresh start lists them on the welcome screen.
  await launch(page, {
    files,
    appData: { "recent.json": JSON.stringify(stored) },
    locale: "en-US",
  });
  const recent = page.getByRole("region", { name: "Recent" });
  await expect(recent.getByRole("button", { name: /loose\.md/ })).toBeVisible();
  await recent.getByRole("button", { name: /^notes/ }).click();
  await expect(item(page, "todo.md")).toBeVisible();
  await page.getByRole("button", { name: "Hide Sidebar" }).click();
  await expect(page.getByRole("tree")).toBeHidden();
});

test("MINT writes no hidden files or private data into the folder", async ({ page }) => {
  await openFolder(page);
  const before = await listPaths(page);

  await item(page, "todo.md").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("- eggs");
  await page.keyboard.press("ControlOrMeta+S");
  await page.getByRole("button", { name: "New Document" }).click();
  await page.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(item(page, "Untitled.md")).toBeVisible();
  await item(page, "journal").click();
  await item(page, "2026.md").click();

  const added = (await listPaths(page)).filter((p) => !before.includes(p));
  expect(added).toEqual(["/notes/Untitled.md"]);
  const hidden = (await listPaths(page)).filter(
    (p) => p.startsWith(`${folder}/`) && p.split("/").some((s) => s.startsWith(".")),
  );
  expect(hidden).toEqual(["/notes/.git", "/notes/.git/HEAD"]);
  expect(await readAppData(page, "recent.json")).toContain("/notes");
});
