import { expect, test } from "@playwright/test";
import {
  externalRemove,
  externalWrite,
  launch,
  readFile,
  runMenuItem,
  settingsPath,
  writeFile,
} from "./memory-platform.ts";

test("review folder changes independently from an unsaved draft in a regular folder", async ({
  page,
}) => {
  const executable = "/fixtures/codex";
  const alternate = "/fixtures/codex-alternate";
  const folderSettings = (path: string) =>
    JSON.stringify({ autosave: false, multiFileWritingConnection: `agent:${path}` });
  const draft = "# Draft\r\n\r\nOriginal.\r\n";
  const unsaved = draft.replace("Original.", "Original. My note.");
  const index = "[Old](old.md#section)\n";
  const requests: unknown[] = [];
  await page.route("**/__test/folder-agent", async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    await route.fulfill({
      json:
        request.request.folderDocuments === undefined
          ? { text: "Revised the example.", taskCopy: "We are reviewing the draft." }
          : {
              text: "Organized the folder copy.",
              fileChanges: [
                { path: "draft.md", text: unsaved.replace("Original.", "Revised.") },
                { path: "index.md", text: "[Old](sub/renamed.md#section) · [Notes](notes.md)\n" },
                { path: "notes.md", text: "# Notes\n" },
                { from: "old.md", path: "sub/renamed.md", text: "## Section\n" },
                { path: "../outside.md", text: "Outside write" },
              ],
            },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: {
      "/book/draft.md": draft,
      "/book/index.md": index,
      "/book/old.md": "## Section\n",
      "/book/sub/private.md": "Unshared material",
      "/outside.md": "Outside original",
      [settingsPath]: folderSettings(executable),
    },
    openedPaths: [
      { path: "/book", kind: "directory" },
      { path: "/book/draft.md", kind: "file" },
    ],
    externalAgent: { executables: [executable, alternate], endpoint: "/__test/folder-agent" },
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "External Agents" }).click();
  for (const path of [executable, alternate]) {
    await settings.getByLabel("Codex executable").fill(path);
    await settings.getByRole("button", { name: "Inspect Agent" }).click();
    await settings.getByLabel("Agent permissions").selectOption("taskCopy");
    await settings.getByRole("button", { name: "Try example" }).click();
    await settings.getByRole("button", { name: "Allow and send" }).click();
    await expect(
      settings.getByText("Task copy editing verified", { exact: true }).first(),
    ).toBeVisible();
  }
  await settings.getByRole("button", { name: "Close" }).click();

  const editor = page.locator(".cm-content");
  await editor.getByText("Original.", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" My note.");
  await runMenuItem(page, "edit.askFolderAI");
  const assistant = page.getByRole("complementary", { name: "Writing Assistant" });
  const recipient = assistant.getByLabel("Recipient").locator("option:checked");
  await expect(recipient).toHaveText(`Codex · ${executable}`);
  await assistant.getByLabel("Action").selectOption({ label: "Preview first" });
  const targets = assistant.getByRole("group", { name: "Documents to include in the task copy" });
  const unshared = targets.getByRole("checkbox", { name: "sub/private.md", exact: true });
  const search = assistant.getByLabel("Allow searching the current working folder");
  await unshared.check();
  await search.check();
  await writeFile(page, settingsPath, folderSettings(alternate));
  await expect(recipient).toHaveText(`Codex · ${alternate}`);
  await expect(unshared).not.toBeChecked();
  await expect(search).not.toBeChecked();
  for (const path of ["draft.md", "index.md", "old.md"]) {
    await targets.getByRole("checkbox", { name: path, exact: true }).check();
  }
  await assistant.getByRole("textbox", { name: "Instruction" }).fill("Organize these documents.");
  await assistant.getByRole("textbox", { name: "Instruction" }).press("Enter");

  const result = assistant.getByRole("region", { name: "Folder changes" });
  const row = (name: string) => result.getByRole("group", { name, exact: true });
  const edit = row("Modify draft.md");
  const backlink = row("Modify index.md");
  const create = row("Create notes.md");
  const move = row("Move and rename old.md → sub/renamed.md");
  const apply = (group: ReturnType<typeof row>) =>
    group.getByRole("button", { name: "Apply proposed edit" });
  await expect(edit).toContainText("Revised. My note.");
  await expect(create).toContainText("Notes");
  await expect(move).toContainText("Section");
  await expect(backlink).toContainText("Requires notes.md, sub/renamed.md");
  await expect(apply(backlink)).toBeDisabled();
  await expect(result).toContainText("Outside the task scope");
  await assistant.getByRole("checkbox", { name: "Show Markdown source" }).check();
  await expect(backlink).toContainText("[Old](sub/renamed.md#section)");
  expect(requests.at(-1)).toMatchObject({
    path: alternate,
    request: {
      folderDocuments: [
        { path: "draft.md", text: unsaved },
        { path: "index.md", text: index },
        { path: "old.md", text: "## Section\n" },
      ],
    },
  });
  expect(JSON.stringify(requests.at(-1))).not.toMatch(/\/book|Unshared material/);
  expect(requests.at(-1)).not.toMatchObject({ request: { taskContext: { folderSearch: true } } });
  expect(await readFile(page, "/book/draft.md")).toBe(draft);
  expect(await readFile(page, "/book/index.md")).toBe(index);
  expect(await readFile(page, "/book/notes.md")).toBeUndefined();
  expect(await readFile(page, "/book/sub/renamed.md")).toBeUndefined();

  await apply(edit).click();
  await expect(editor).toContainText("Revised. My note.");
  expect(await readFile(page, "/book/draft.md")).toBe(draft);
  await externalWrite(page, "/book/notes.md", "Newer author file");
  await apply(create).click();
  await expect(create.getByRole("alert")).toContainText("Could not apply this file change");
  expect(await readFile(page, "/book/notes.md")).toBe("Newer author file");
  await expect(apply(backlink)).toBeDisabled();
  await externalRemove(page, "/book/notes.md");
  await apply(create).click();
  await expect.poll(() => readFile(page, "/book/notes.md")).toBe("# Notes\n");
  await expect(apply(backlink)).toBeDisabled();
  await apply(move).click();
  await expect(apply(backlink)).toBeEnabled();
  expect(await readFile(page, "/book/old.md")).toBeUndefined();
  expect(await readFile(page, "/book/sub/renamed.md")).toBe("## Section\n");
  await apply(backlink).click();
  await expect
    .poll(() => readFile(page, "/book/index.md"))
    .toBe("[Old](sub/renamed.md#section) · [Notes](notes.md)\n");
  expect(await readFile(page, "/outside.md")).toBe("Outside original");
});
