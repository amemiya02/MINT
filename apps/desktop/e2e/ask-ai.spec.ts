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
