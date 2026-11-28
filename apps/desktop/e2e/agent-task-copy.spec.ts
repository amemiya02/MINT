import { expect, type Page, test } from "@playwright/test";
import { externalWrite, launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

async function configureTaskCopy(page: Page, executable: string, beforeConsent?: () => void) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "External Agents" }).click();
  await settings.getByRole("button", { name: "Discover Codex" }).click();
  await settings.getByRole("button", { name: executable, exact: true }).click();
  await settings.getByLabel("Agent permissions").selectOption("taskCopy");
  await settings.getByRole("button", { name: "Try example" }).click();
  beforeConsent?.();
  await settings.getByRole("button", { name: "Allow and send" }).click();
  await expect(settings.getByText("Task copy editing verified", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
}

async function sendDocumentEdit(page: Page, action: "Preview first" | "Apply directly") {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox").fill("Ask AI");
  await page.keyboard.press("Enter");
  const composer = page.getByRole("region", { name: "Ask AI" });
  await composer.getByLabel("Scope").selectOption("document");
  await composer.getByLabel("Action").selectOption({ label: action });
  const input = composer.getByRole("textbox", { name: "Instruction" });
  await input.fill("Shorten the original sentence.");
  await input.press("Enter");
  return composer;
}

test("an Agent can preview and directly edit a task copy of the unsaved manuscript", async ({
  page,
}) => {
  const executable = "/fixtures/codex";
  const path = "/notes/draft.md";
  const source = "Opening stays.  \r\n\r\nOriginal sentence.\r\n";
  const unsaved = source.replace("Original sentence.", "Original sentence. Handwritten note.");
  const proposed = unsaved.replace("Original sentence.", "Short sentence.");
  const received: unknown[] = [];
  await page.route("**/__test/task-copy", async (route) => {
    received.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        text: "Revised the copy.",
        taskCopy: received.length === 1 ? "We are reviewing the draft." : proposed,
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
    externalAgent: { executables: [executable], endpoint: "/__test/task-copy" },
  });

  await configureTaskCopy(page, executable, () => expect(received).toHaveLength(0));

  const editor = page.locator(".cm-content");
  await editor.getByText("Original sentence.", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Handwritten note.");

  const preview = await sendDocumentEdit(page, "Preview first");
  await expect(preview.getByRole("button", { name: "Apply proposed edit" })).toBeVisible();
  await expect(editor).toContainText("Original sentence. Handwritten note.");
  expect(await readFile(page, path)).toBe(source);
  await preview.getByRole("button", { name: "Close" }).click();

  await sendDocumentEdit(page, "Apply directly");
  await expect(editor).toContainText("Short sentence. Handwritten note.");
  expect(await readFile(page, path)).toBe(source);
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(proposed);
  expect(received.slice(1)).toEqual(
    [1, 2].map(() => ({
      path: executable,
      access: "taskCopy",
      request: {
        instruction: expect.stringContaining("Shorten the original sentence."),
        taskCopy: "edit",
        taskContext: { currentDraft: { name: "draft.md", text: unsaved } },
      },
    })),
  );
});

test("a task-copy proposal follows typing after its range is mapped to the live manuscript", async ({
  page,
}) => {
  const executable = "/fixtures/codex";
  const path = "/notes/draft.md";
  const original = "Original sentence.";
  const author = "The author rewrote this.";
  const replacement = "Short sentence.";
  const source = `Opening stays.  \r\n\r\n${original}\r\n`;
  const prefaced = source.replace("Opening stays.", "New preface. Opening stays.");
  let editing = false;
  let releaseReply!: () => void;
  const pending = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  await page.route("**/__test/task-copy", async (route) => {
    if (route.request().postDataJSON().request.selectedText) {
      await route.fulfill({ json: { text: "Edited the example.", taskCopy: "Short example." } });
      return;
    }
    editing = true;
    await pending;
    await route.fulfill({
      json: { text: "Edited the copy.", taskCopy: source.replace(original, replacement) },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
    externalAgent: { executables: [executable], endpoint: "/__test/task-copy" },
  });
  await configureTaskCopy(page, executable);

  const preview = await sendDocumentEdit(page, "Preview first");
  await expect.poll(() => editing).toBe(true);
  const editor = page.locator(".cm-content");
  await editor.getByText("Opening stays.", { exact: true }).click();
  await editor.press("Home");
  await page.keyboard.insertText("New preface. ");
  releaseReply();
  await expect(preview.getByRole("button", { name: "Apply proposed edit" })).toBeVisible();

  await editor.getByText(original, { exact: true }).click();
  await editor.press("Home");
  await editor.press("Shift+End");
  await page.keyboard.type(author);
  const review = preview.getByRole("group", { name: "Proposed edit 1 of 1" });
  await expect(review.getByText(author, { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(source);
  await review.getByRole("button", { name: "Apply to compared text" }).click();
  await editor.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(prefaced.replace(original, replacement));
  await editor.press("ControlOrMeta+Z");
  await editor.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(prefaced.replace(original, author));
});

test("a task-copy draft preserves its Markdown and keeps approved source provenance local", async ({
  page,
}) => {
  const executable = "/fixtures/codex";
  const source = "/notes/ridge.md";
  const draftPath = "/notes/bulletin.md";
  const claim = "The north ridge reopened Tuesday.";
  const revised = "The north ridge stayed closed.";
  const draft = `${claim}\n\nThe literal marker is \`<source-passages>\`.\n`;
  const requests: unknown[] = [];
  await page.route("**/__test/task-copy", async (route) => {
    requests.push(route.request().postDataJSON());
    const replies = [
      { text: "Edited the example.", taskCopy: "We are reviewing the draft." },
      {
        text: JSON.stringify({
          requestMaterial: { name: "Ridge log", purpose: "Check access.", query: "north ridge" },
        }),
      },
      {
        taskCopy: draft,
        text: `<source-passages>\n${JSON.stringify([{ claim, material: 1, quote: claim }])}\n</source-passages>`,
      },
    ];
    await route.fulfill({ json: replies[requests.length - 1] });
  });
  await launch(page, {
    locale: "en-US",
    files: { [source]: `Private notes.\n${claim}\n` },
    openedPaths: [{ path: "/notes", kind: "directory" }],
    saveDialogResults: [draftPath],
    externalAgent: { executables: [executable], endpoint: "/__test/task-copy" },
  });
  await configureTaskCopy(page, executable);
  await runMenuItem(page, "file.draftWithAi");
  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("Writing connection").selectOption(`agent:${executable}`);
  await composer.getByLabel("Drafting instruction").fill("Draft one statement about the ridge.");
  await composer.getByLabel("Allow searching the current working folder").check();
  await composer.getByRole("button", { name: "Generate draft" }).click();
  const approval = composer.getByRole("group", { name: "Additional material requested" });
  const label = "ridge.md · line 2";
  await approval.getByRole("radio", { name: label }).check();
  await approval.getByRole("button", { name: "Allow once" }).click();
  const review = page.getByRole("region", { name: "Source passages" });
  await review.getByRole("button", { name: claim, exact: true }).click();
  await runMenuItem(page, "file.save");
  await expect.poll(() => readFile(page, draftPath)).toBe(draft);
  expect(requests[2]).toMatchObject({
    access: "taskCopy",
    request: {
      taskCopy: "draft",
      instruction: expect.stringContaining("write the Markdown to the task copy"),
      taskContext: {
        materialDecisions: [
          { name: "Ridge log", outcome: "allowed", material: { name: label, text: claim } },
        ],
      },
    },
  });
  expect(JSON.stringify(requests)).not.toMatch(/\/notes|Private notes/);
  await externalWrite(page, source, `Private notes.\n${revised}\n`);
  await review.getByRole("button", { name: "Read current source" }).click();
  await expect(review.getByRole("region", { name: "Source comparison" })).toContainText(revised);
  expect(requests).toHaveLength(3);
});

test("an interrupted Agent copy remains a proposal even in direct mode", async ({ page }) => {
  const executable = "/fixtures/codex";
  const path = "/notes/interrupted.md";
  const original = "Original sentence.";
  const revised = "Short sentence.";
  let calls = 0;
  await page.route("**/__test/task-copy", (route) => {
    calls++;
    return route.fulfill({
      json:
        calls === 1
          ? { text: "", taskCopy: "We are reviewing the draft." }
          : { text: "More work was interrupted.", taskCopy: revised, finishReason: "interrupted" },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [path]: original, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
    externalAgent: { executables: [executable], endpoint: "/__test/task-copy" },
  });
  await configureTaskCopy(page, executable);
  const composer = await sendDocumentEdit(page, "Apply directly");
  await expect(composer.getByText("More work was interrupted.", { exact: true })).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText(original);
  expect(await readFile(page, path)).toBe(original);
  await composer.getByRole("button", { name: "Apply proposed edit" }).click();
  await expect(page.locator(".cm-content")).toHaveText(revised);
  await runMenuItem(page, "file.save");
  await expect.poll(() => readFile(page, path)).toBe(revised);
});
