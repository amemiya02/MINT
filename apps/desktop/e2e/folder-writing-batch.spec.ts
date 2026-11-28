import { expect, test } from "@playwright/test";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import {
  externalRemove,
  externalWrite,
  files,
  launch,
  readFile,
  runMenuItem,
  settingsPath,
} from "./memory-platform.ts";

test("an authorized folder batch continues after a collision and retries only unfinished writes", async ({
  page,
  browser,
}) => {
  const agent = "/fixtures/codex";
  const endpoint = "**/__test/folder-batch";
  const draft = "Original.\r\n\r\nEnd.\r\n";
  const revised = "Revised.\r\n\r\nEnd. My draft note.\r\n";
  const index = "# Index\n";
  const requestPaths: (string[] | undefined)[] = [];
  const requestInstructions: string[] = [];
  const instruction = "/copyedit Update the folder, apply directly.";
  await page.route(endpoint, async (route) => {
    const { request } = route.request().postDataJSON();
    if (!request.folderDocuments) {
      await route.fulfill({ json: { taskCopy: "We are reviewing the draft." } });
      return;
    }
    requestPaths.push(request.folderWriteTargets);
    requestInstructions.push(request.instruction);
    await externalWrite(page, "/book/notes.md", "Author's new file\n");
    await externalWrite(page, "/book/appendix.md", "Concurrent author edit\n");
    await route.fulfill({
      json: {
        text: "Updated the folder copy.",
        fileChanges: [
          { path: "index.md", text: "[Notes](notes.md)\n" },
          { path: "notes.md", text: "# Notes\n" },
          { path: "appendix.md", text: "Agent appendix\n" },
          { path: "draft.md", text: revised },
          { path: "private.md", text: "Unapproved write\n" },
          { path: "../outside.md", text: "Outside write\n" },
        ],
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: {
      "/book/draft.md": draft,
      "/book/index.md": index,
      "/book/appendix.md": "Appendix\n",
      "/book/private.md": "Read-only material\n",
      "/outside.md": "Outside original\n",
      [settingsPath]: JSON.stringify({
        autosave: false,
        multiFileWritingConnection: `agent:${agent}`,
      }),
    },
    openedPaths: [
      { path: "/book", kind: "directory" },
      { path: "/book/draft.md", kind: "file" },
    ],
    externalAgent: { executables: [agent], endpoint: "/__test/folder-batch" },
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "External Agents" }).click();
  await settings.getByLabel("Codex executable").fill(agent);
  await settings.getByRole("button", { name: "Inspect Agent" }).click();
  await settings.getByLabel("Agent permissions").selectOption("taskCopy");
  await settings.getByRole("button", { name: "Try example" }).click();
  await settings.getByRole("button", { name: "Allow and send" }).click();
  await expect(settings.getByText("Task copy editing verified", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();

  await page.locator(".cm-content").getByText("End.", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" My draft note.");
  expect(await readFile(page, "/book/draft.md")).toBe(draft);
  await runMenuItem(page, "edit.askFolderAI");
  const assistant = page.getByRole("complementary", { name: "Writing Assistant" });
  await assistant.getByRole("textbox", { name: "Instruction" }).fill(instruction);
  await expect(assistant.getByLabel("Action")).toHaveValue("direct");
  const send = assistant.getByRole("button", { name: /Apply directly · Working folder/ });
  await expect(send).toBeDisabled();
  const documents = assistant.getByRole("group", { name: "Documents to include in the task copy" });
  for (const path of ["draft.md", "index.md", "appendix.md", "private.md"]) {
    await documents.getByRole("checkbox", { name: path, exact: true }).check();
  }
  const targets = ["draft.md", "index.md", "appendix.md", "notes.md"];
  await assistant
    .getByLabel("Write targets (one relative Markdown path per line)")
    .fill(targets.join("\n"));
  const writeList = assistant.getByRole("list", { name: "Files authorized for writing" });
  await expect(writeList.getByRole("listitem")).toHaveText(targets);
  expect(requestPaths).toEqual([]);
  await expect(send).toBeEnabled();
  await send.click();

  const result = assistant.getByRole("region", { name: "Folder changes" });
  await expect(result.getByRole("group", { name: "Modify draft.md" })).toContainText("Written");
  await expect(result.getByRole("group", { name: "Create notes.md" })).toContainText(
    "Could not apply",
  );
  await expect(result.getByRole("group", { name: "Modify appendix.md" })).toContainText(
    "The document changed",
  );
  await expect(result.getByRole("group", { name: "Modify index.md" })).toContainText(
    "Waiting for required file changes",
  );
  await expect(result).toContainText("Outside the task scope · private.md");
  await expect(result).toContainText("Outside the task scope · ../outside.md");
  expect(requestPaths).toEqual([targets]);
  expect(requestInstructions).toEqual([
    [
      "Correct spelling, punctuation, and grammar.",
      "Check capitalization and terminology for consistency.",
      "Preserve the author's meaning, voice, and Markdown structure.",
      "Follow the author's task instructions where they refine these steps.",
      "Update the folder, apply directly.",
      "Revise the text. Keep the rest of the passage intact.",
    ].join("\n"),
  ]);
  expect(await readFile(page, "/book/draft.md")).toBe(revised);
  await expect(page.locator(".cm-content")).toContainText("Revised.");
  expect(await readFile(page, "/book/index.md")).toBe(index);
  expect(await readFile(page, "/book/notes.md")).toBe("Author's new file\n");
  expect(await readFile(page, "/book/appendix.md")).toBe("Concurrent author edit\n");
  expect(await readFile(page, "/book/private.md")).toBe("Read-only material\n");
  expect(await readFile(page, "/outside.md")).toBe("Outside original\n");

  const later = revised.replace("Revised.", "Revised. Independent author note.");
  await externalWrite(page, "/book/draft.md", later);
  await externalRemove(page, "/book/notes.md");
  await result.getByRole("button", { name: "Retry unfinished file changes" }).click();
  await expect(result.getByRole("group", { name: "Modify index.md" })).toContainText("Written");
  expect(await readFile(page, "/book/draft.md")).toBe(later);
  expect(await readFile(page, "/book/index.md")).toBe("[Notes](notes.md)\n");
  expect(await readFile(page, "/book/notes.md")).toBe("# Notes\n");
  expect(requestPaths).toEqual([targets]);

  await runMenuItem(page, "edit.allWritingTasks");
  await expect(page.getByRole("button", { name: instruction, exact: true })).toBeVisible();
  const appData = await page.evaluate(() =>
    Object.fromEntries(
      (window as unknown as { __MINT_MEMORY_PLATFORM__: MemoryPlatform }).__MINT_MEMORY_PLATFORM__
        .appData,
    ),
  );
  const restarted = await browser.newContext();
  try {
    await restarted.route(endpoint, (route) => {
      requestPaths.push(undefined);
      return route.abort();
    });
    const resumed = await restarted.newPage();
    await launch(resumed, {
      locale: "en-US",
      appData,
      files: await files(page),
      openedPaths: [
        { path: "/book", kind: "directory" },
        { path: "/book/draft.md", kind: "file" },
      ],
    });
    await runMenuItem(resumed, "edit.allWritingTasks");
    await resumed.getByRole("button", { name: instruction, exact: true }).click();
    const saved = resumed.getByRole("region", { name: "Folder changes" });
    await saved.getByRole("button", { name: "Revert all task edits" }).click({ timeout: 5000 });
    await expect(saved.getByRole("group", { name: "Modify draft.md" })).toContainText(
      "Edit reverted",
    );
    expect(await readFile(resumed, "/book/draft.md")).toBe(later.replace("Revised.", "Original."));
    expect(await readFile(resumed, "/book/index.md")).toBe(index);
    expect(await readFile(resumed, "/book/notes.md")).toBeUndefined();
    expect(await readFile(resumed, "/book/appendix.md")).toBe("Concurrent author edit\n");
    expect(requestPaths).toEqual([targets]);
  } finally {
    await restarted.close();
  }
});
