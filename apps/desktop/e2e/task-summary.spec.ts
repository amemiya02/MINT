import { expect, type Page, test } from "@playwright/test";
import { externalWrite, launch, readFile, runMenuItem } from "./memory-platform.ts";

const name = "Task summary";
const report = "/notes/research/report.markdown";
const files = {
  [report]: "\uFEFF# Research\r\n\r\n1. [ ] Check the draft\r\n   - [X] Verify citation  \r\n",
  "/notes/draft.md": "# Draft\n\n- [ ] Verify citation\n\n```md\n- [ ] Example only\n```\n",
  "/notes/.gitignore": "generated/\n",
  "/notes/generated/archive.md": "- [ ] Ignored task",
  "/notes/metadata.md": "---\nexamples:\n  - [ ] Only metadata\n---\n",
  "/notes/archive.txt": "- [ ] Not Markdown",
  "/private.md": "- [ ] Private",
};

async function openSummary(page: Page) {
  await launch(page, { locale: "en-US", files, openFolderDialogResults: ["/notes"] });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const plugin = settings.getByRole("group", { name, exact: true });
  await expect(plugin).toBeVisible();
  await plugin.getByRole("button", { name: "Install", exact: true }).click();
  await settings.getByRole("button", { name: "Allow access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const entry = page
    .getByRole("navigation", { name: "Document tools" })
    .getByRole("button", { name });
  await entry.click();
  return page.getByRole("complementary", { name });
}

test("installed task summary shows Markdown tasks, their status and their exact source", async ({
  page,
}) => {
  const view = await openSummary(page);
  const tasks = view.getByRole("button");
  await expect(tasks).toHaveCount(3);
  await expect(tasks.filter({ hasText: "draft.md:3" })).toContainText("To do");
  const completed = tasks.filter({ hasText: "research/report.markdown:4" });
  await expect(completed).toContainText("Completed");
  await expect(completed).toContainText("Verify citation");
  await completed.click();
  await expect(page).toHaveTitle("report.markdown — MINT");
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("Verify citation");
  for (const [path, source] of Object.entries(files))
    expect(await readFile(page, path)).toBe(source);
});

test("the open summary follows saved edits, new files, and external task changes", async ({
  page,
}) => {
  const view = await openSummary(page);
  const original = view.getByRole("button").filter({ hasText: "draft.md:3" });
  await original.click();
  await page.keyboard.insertText("Ask the editor");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(original).toContainText("Ask the editor");
  const updated = "\uFEFF# Updated\r\n\r\n\r\n- [x] Ask **again**  \r\n";
  await externalWrite(page, report, updated);
  await expect(view.getByRole("button")).toHaveCount(2);
  const moved = view.getByRole("button").filter({ hasText: "report.markdown:4" });
  await expect(moved).toContainText("Ask again");
  await moved.click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("Ask **again**");
  await externalWrite(page, "/notes/later.md", "# Earlier draft\r\r- [ ] Newly added");
  const added = view.getByRole("button", { name: /Newly added/ });
  await expect(added).toContainText("later.md:3");
  await added.click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("Newly added");
  expect(await readFile(page, report)).toBe(updated);
});

test("an imported task sidebar follows its folder, read grant, and installation", async ({
  page,
}) => {
  const packageName = "Research checklist";
  await launch(page, {
    locale: "en-US",
    files: { ...files, "/separate/empty.md": "# New folder" },
    openFolderDialogResults: ["/notes", "/separate"],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Install a MINT plugin file").setInputFiles({
    name: "research-checklist.mint.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        apiVersion: 1,
        id: "example.research-checklist",
        name: packageName,
        sidebar: "tasks",
        permissions: ["folder.read"],
      }),
    ),
  });
  await expect(settings.getByText("Read Markdown documents in the current folder")).toBeVisible();
  await settings.getByRole("button", { name: "Deny access" }).click();
  const close = settings.getByRole("button", { name: "Close", exact: true });
  await close.click();
  await runMenuItem(page, "file.openFolder");
  await page.getByRole("treeitem", { name: "draft.md" }).waitFor();
  const entry = page.getByRole("button", { name: packageName, exact: true });
  const view = page.getByRole("complementary", { name: packageName });
  const plugin = settings.getByRole("group", { name: packageName });
  await entry.click();
  await expect(view.getByRole("alert")).toContainText("denied");
  await expect(view.getByRole("button")).toHaveCount(0);
  async function changeSetting(action: string) {
    await page.keyboard.press("ControlOrMeta+,");
    await plugin.getByRole("button", { name: action, exact: true }).click();
    await close.click();
  }
  await changeSetting("Allow access");
  await expect(view.getByRole("button")).toHaveCount(3);
  await changeSetting("Revoke access");
  await expect(view.getByRole("alert")).toContainText("denied");
  await expect(view.getByRole("button")).toHaveCount(0);
  await changeSetting("Allow access");
  await runMenuItem(page, "file.openFolder");
  await page.getByRole("treeitem", { name: "empty.md" }).waitFor();
  await entry.click();
  await expect(view).toContainText("No tasks in this folder.");
  await expect(view.getByRole("button")).toHaveCount(0);
  await changeSetting("Disable");
  await expect(entry).toHaveCount(0);
  await expect(view).toHaveCount(0);
  await changeSetting("Uninstall");
  await expect(entry).toHaveCount(0);
});
