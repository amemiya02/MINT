import { expect, type Page, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

async function configureAgent(page: Page, executable: string) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "External Agents" }).click();
  await settings.getByRole("button", { name: "Discover Codex" }).click();
  await settings.getByRole("button", { name: executable, exact: true }).click();
  await settings.getByRole("button", { name: "Try example" }).click();
  await settings.getByRole("button", { name: "Allow and send" }).click();
  await expect(settings.getByText("Sample reply.")).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
}

test("Ask AI comments inline and continues from the original selection", async ({ page }) => {
  const path = "/notes/draft.md";
  const executable = "/fixtures/codex";
  const source = "Private paragraph.\n\nOriginal line.\n\nKeep this ending.";
  const selection = "Unsaved phrase.";
  const first = "Does this read clearly?";
  const reply = "<replacement>A comment asking for a clearer subject.</replacement>";
  const followUp = "What should the subject be?";
  const requestMaterial = { name: "Team roster", purpose: "Confirm the team's name." };
  const received: unknown[] = [];
  await page.route("**/__test/ask-ai", async (route) => {
    received.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        text:
          received.length === 1
            ? "Sample reply."
            : received.length === 2
              ? reply
              : received.length === 3
                ? JSON.stringify({ requestMaterial })
                : "Name the team.",
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
    externalAgent: { executables: [executable], endpoint: "/__test/ask-ai" },
  });

  await configureAgent(page, executable);

  const editor = page.locator(".cm-content");
  await editor.getByText("Original line.", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(` ${selection}`);
  for (const _ of selection) await page.keyboard.press("Shift+ArrowLeft");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();

  const inline = page.getByRole("region", { name: "Ask AI" });
  await inline.getByLabel("Action").selectOption({ label: "Comment only" });
  await expect(inline.getByLabel("Scope")).toHaveValue("selection");
  await expect(inline.getByLabel("Recipient")).toContainText(executable);
  await expect(inline.getByText(selection, { exact: true })).toBeVisible();
  await expect(inline.getByText("Private paragraph.", { exact: true })).toHaveCount(0);
  await inline.getByLabel("Scope").selectOption({ label: "Current document" });
  await expect(inline.getByText(/Private paragraph\.[\s\S]*Keep this ending\./)).toBeVisible();
  await inline.getByLabel("Scope").selectOption({ label: "Current selection" });
  await inline.getByRole("textbox", { name: "Instruction" }).fill(first);
  await inline.getByRole("textbox", { name: "Instruction" }).press("Enter");

  await expect(inline.getByText(reply, { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Writing Assistant" })).toHaveCount(0);
  await expect(editor).toContainText(`Original line. ${selection}`);
  await expect(editor).not.toContainText("A comment asking");
  expect(await readFile(page, path)).toBe(source);

  await inline.getByRole("button", { name: "Continue in sidebar" }).click();
  const sidebar = page.getByRole("complementary", { name: "Writing Assistant" });
  await expect(sidebar.getByText(first, { exact: true })).toBeVisible();
  await sidebar.getByLabel("Scope").selectOption({ label: "Instruction only" });
  await sidebar.getByRole("textbox", { name: "Instruction" }).fill(followUp);
  await sidebar.getByRole("button", { name: /^Comment only · Instruction only · Codex/ }).click();
  const approval = { name: "Additional material requested" };
  await expect(
    sidebar.getByRole("group", approval).getByText(requestMaterial.purpose),
  ).toBeVisible();
  await sidebar.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Resume conversation" }).click();
  const inlineApproval = inline.getByRole("group", approval);
  await expect(inlineApproval).toBeVisible({ timeout: 5000 });
  expect(received).toHaveLength(3);
  await inlineApproval.getByRole("button", { name: "Skip" }).click();
  await expect(inline.getByRole("textbox", { name: "AI reply" })).toHaveValue("Name the team.");
  await inline.getByRole("button", { name: "Continue in sidebar" }).click();
  await expect(sidebar.getByText("Name the team.")).toBeVisible();

  await editor.getByText("Private paragraph.", { exact: true }).click();
  await page.keyboard.press("Home");
  await page.keyboard.insertText("New note. ");
  await expect(editor).toContainText("New note. Private paragraph.");
  await sidebar.getByRole("button", { name: "Go to original selection" }).click();
  await expect(editor).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
  expect(received.slice(1)).toEqual([
    {
      path: executable,
      access: "readOnly",
      request: { instruction: first, selectedText: selection },
    },
    {
      path: executable,
      access: "readOnly",
      request: { instruction: followUp, history: [{ instruction: first, reply }] },
    },
    {
      path: executable,
      access: "readOnly",
      request: {
        instruction: expect.stringContaining(followUp),
        history: [{ instruction: first, reply }],
        taskContext: { materialDecisions: [{ ...requestMaterial, outcome: "skipped" }] },
      },
    },
  ]);
});

test("selection rewrites preview first or apply with one undo step", async ({ page }) => {
  const path = "/notes/rewrite.md";
  const executable = "/fixtures/codex";
  const selection = "We all met with the entire team.";
  const source = "\uFEFFPrivate paragraph.  \r\n\nOriginal line.\r\n";
  const endpoint = "https://model.example.test/v1/chat/completions";
  const requests: { authorization?: string; body: unknown }[] = [];
  await page.route(endpoint, (route) => {
    requests.push({
      authorization: route.request().headers().authorization,
      body: route.request().postDataJSON(),
    });
    return route.fulfill({
      json: {
        choices: [
          {
            message: { content: "<replacement>The team met.</replacement>" },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await page.route("**/__test/ask-ai-edit", (route) =>
    route.fulfill({
      json: {
        text:
          route.request().postDataJSON().request.selectedText === selection
            ? "<replacement>The team met.</replacement>"
            : "Sample reply.",
      },
    }),
  );
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
    externalAgent: { executables: [executable], endpoint: "/__test/ask-ai-edit" },
  });
  await configureAgent(page, executable);

  const editor = page.locator(".cm-content");
  await editor.getByText("Original line.", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(` ${selection}`);
  for (const _ of selection) await page.keyboard.press("Shift+ArrowLeft");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox").fill("Ask AI");
  await page.keyboard.press("Enter");
  const inline = page.getByRole("region", { name: "Ask AI" });
  const instruction = inline.getByRole("textbox", { name: "Instruction" });
  await expect(inline.getByLabel("Action")).toHaveValue("preview");
  await instruction.fill("Shorten this sentence.");
  await instruction.press("Enter");
  await expect(inline.getByRole("button", { name: "Apply proposed edit" })).toBeVisible();
  await expect(editor).toContainText(selection);
  await inline.getByText("Use part of the reply", { exact: true }).click({ timeout: 5000 });
  await expect(inline.getByRole("textbox", { name: "AI reply" })).toHaveValue("The team met.");

  await inline.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await inline.getByRole("button", { name: "Connection settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Editorial model");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture-writer");
  await settings.getByLabel("API key").fill("fixture-key");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Editorial model" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
  await inline.getByLabel("Recipient").selectOption({ label: `Editorial model · ${endpoint}` });
  await instruction.fill("Shorten this sentence, apply directly");
  await expect(inline.getByLabel("Action")).toHaveValue("direct");
  await instruction.press("Enter");
  await expect(editor).toContainText("Original line. The team met.");
  await expect(editor).toBeFocused();
  expect(requests).toEqual([
    {
      authorization: "Bearer fixture-key",
      body: {
        model: "fixture-writer",
        stream: false,
        messages: [
          { role: "system", content: expect.stringContaining("<replacement>") },
          {
            role: "user",
            content: JSON.stringify({
              instruction: "Shorten this sentence, apply directly",
              selectedText: selection,
            }),
          },
        ],
      },
    },
  ]);
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe(source.replace("Original line.", "Original line. The team met."));
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(editor).toContainText(`Original line. ${selection}`);
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe(source.replace("Original line.", `Original line. ${selection}`));
});

test("a selected reply excerpt can be used in the manuscript or in a new draft", async ({
  page,
}) => {
  const path = "/notes/draft.md";
  const reference = "/notes/reference.md";
  const savedExcerpt = "/notes/excerpt.md";
  const executable = "/fixtures/codex";
  const source = "Opening stays.  \r\n\r\nOriginal sentence.\r\n";
  const excerpt = "Use this sentence.";
  const reply = `Extra context.\n${excerpt}\nLeave this out.`;
  await page.route("**/__test/reply-excerpt", (route) =>
    route.fulfill({
      json: {
        text:
          route.request().postDataJSON().request.selectedText === "Original sentence."
            ? reply
            : "Sample reply.",
      },
    }),
  );
  await launch(page, {
    locale: "en-US",
    files: {
      [path]: source,
      [reference]: "Reference text: ",
      [settingsPath]: '{"autosave":false}',
    },
    openedPaths: [{ path, kind: "file" }],
    openDialogResults: [reference],
    saveDialogResults: [savedExcerpt],
    externalAgent: { executables: [executable], endpoint: "/__test/reply-excerpt" },
  });
  await configureAgent(page, executable);

  const manuscript = page.getByRole("tabpanel", { name: "draft.md" }).first();
  await manuscript.getByText("Original sentence.", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await manuscript.getByRole("button", { name: "Ask AI", exact: true }).click();
  const inline = manuscript.getByRole("region", { name: "Ask AI" });
  await inline.getByLabel("Action").selectOption({ label: "Comment only" });
  await inline.getByRole("textbox", { name: "Instruction" }).fill("Suggest wording.");
  await inline.getByRole("textbox", { name: "Instruction" }).press("Enter");
  const replyText = inline.getByRole("textbox", { name: "AI reply" });
  await expect(replyText).toHaveValue(reply);

  await page.getByRole("button", { name: "Open draft.md in other pane" }).click();
  await page.keyboard.press("ControlOrMeta+O");
  const referenceEditor = page
    .getByRole("tabpanel", { name: "reference.md" })
    .locator(".cm-content");
  await referenceEditor.click();
  await page.keyboard.press("End");

  await replyText.evaluate(
    (field: HTMLTextAreaElement, [from, to]) => {
      field.focus();
      field.setSelectionRange(from, to);
    },
    [reply.indexOf(excerpt), reply.indexOf(excerpt) + excerpt.length] as const,
  );
  const insert = inline.getByRole("button", { name: "Insert at cursor in reference.md" });
  await expect(insert).toBeEnabled();
  await insert.click();
  await expect(referenceEditor).toHaveText(`Reference text: ${excerpt}`);
  const manuscriptEditor = manuscript.locator(".cm-content");
  await expect(manuscriptEditor).toContainText("Original sentence.");

  const referenceTabs = page.getByRole("tablist").last();
  await referenceTabs.getByRole("tab", { name: "draft.md" }).click();
  const peerEditor = page.getByRole("tabpanel", { name: "draft.md" }).last().locator(".cm-content");
  await peerEditor.getByText("Opening stays.", { exact: true }).click();
  await page.keyboard.press("Home");
  await page.keyboard.insertText("Author note. ");
  await referenceTabs.getByRole("tab", { name: "reference.md" }).click();
  const replace = inline.getByRole("button", { name: "Replace original selection in draft.md" });
  await expect(replace).toBeEnabled();
  await replace.click();
  await expect(manuscriptEditor).toBeFocused();
  await expect(referenceEditor).toHaveText(`Reference text: ${excerpt}`);
  expect(await readFile(page, path)).toBe(source);
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe(`Author note. ${source.replace("Original sentence.", excerpt)}`);
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(manuscriptEditor).toContainText("Original sentence.");
  await expect(manuscriptEditor).toContainText("Author note. Opening stays.");

  await referenceTabs.getByRole("tab", { name: "draft.md" }).click();
  await peerEditor.getByText("Original sentence.", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.insertText("Hand-edited sentence.");
  await replace.click();
  await expect(inline.getByRole("alert")).toContainText("The original selection changed");
  await expect(inline.getByText("Hand-edited sentence.", { exact: true })).toBeVisible();
  await expect(inline.getByText(excerpt, { exact: true })).toBeVisible();
  await expect(peerEditor).toContainText("Hand-edited sentence.");
  await expect(manuscriptEditor).toContainText("Hand-edited sentence.");

  await inline.getByRole("button", { name: "Create new untitled draft" }).click({ timeout: 5000 });
  const newDraft = page.getByRole("tabpanel", { name: "Untitled" }).locator(".cm-content");
  await expect(newDraft).toHaveText(excerpt);
  expect(await readFile(page, savedExcerpt)).toBeUndefined();
  await newDraft.press("End");
  await page.keyboard.insertText(" My addition.");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, savedExcerpt)).toBe(`${excerpt} My addition.`);
  await expect(manuscriptEditor).toContainText("Hand-edited sentence.");
});
