import { expect, type Locator, test } from "@playwright/test";
import { launch, questionsAsked, runMenuItem } from "./memory-platform.ts";

test("remember an interview correction at the chosen scope and review what will be sent", async ({
  page,
}) => {
  const address = "https://interview.example.test/v1";
  const selectedText = 'The interviewee said, "I ain\'t going."';
  const defaults = "Standardize grammar throughout.";
  const folderRule = "Preserve the interviewee’s exact words.";
  const taskRule = "Remove the direct quote and paraphrase it.";
  const paraphrased = "The interviewee said they would not go.";
  const standardized = 'The interviewee said, "I am not going."';
  const explicit = "For this request, keep the interviewee’s exact words.";
  const received: { role: string; content: string }[][] = [];
  await page.route(`${address}/chat/completions`, (route) => {
    const messages = route.request().postDataJSON().messages;
    received.push(messages);
    const { instruction, preferences } = JSON.parse(messages.at(-1).content);
    const guidance = preferences?.find(
      (preference: { topic: string }) => preference.topic === "Interview quotations",
    )?.guidance;
    const content =
      instruction === explicit || guidance === folderRule
        ? selectedText
        : guidance === taskRule
          ? paraphrased
          : standardized;
    return route.fulfill({ json: { choices: [{ message: { content } }] } });
  });

  await launch(page, {
    locale: "en-US",
    openedPaths: [
      { path: "/interviews", kind: "directory" },
      { path: "/interviews/draft.md", kind: "file" },
    ],
    files: {
      "/interviews/draft.md": selectedText,
      "/another/brief.md": selectedText,
    },
    openDialogResults: ["/another/brief.md"],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Interview model");
  await settings.getByLabel("API address").fill(address);
  await settings.getByLabel("Model name").fill("interview-fixture");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Interview model" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();

  const inline = page.getByRole("region", { name: "Ask AI" });
  const sidebar = page.getByRole("complementary", { name: "Writing Assistant" });
  const preferences = (composer: Locator) =>
    composer.getByRole("group", { name: "Writing preferences to send" });
  async function openSelection() {
    await page.locator(".cm-content:visible").press("ControlOrMeta+A");
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  }
  async function remember(scope: string, guidance: string) {
    const panel = preferences(inline);
    if (!(await panel.getByLabel("Remember for").isVisible())) {
      await panel.getByText("Remember a correction", { exact: true }).click();
    }
    await panel.getByLabel("Remember for").selectOption({ label: scope });
    await panel.getByLabel("Topic").fill("Interview quotations");
    await panel.getByLabel("Writing guidance").fill(guidance);
    await panel.getByRole("button", { name: "Save writing preference" }).click();
  }
  async function send(composer: Locator, instruction: string, guidance: string, result: string) {
    const count = received.length;
    await composer.getByLabel("Instruction", { exact: true }).fill(instruction);
    await composer.getByLabel("Instruction", { exact: true }).press("Enter");
    await expect.poll(() => received.length).toBe(count + 1);
    await expect(composer.getByText(result, { exact: true }).last()).toBeVisible();
    const messages = received.at(-1);
    const input = JSON.parse(messages?.at(-1)?.content ?? "");
    expect(input).toMatchObject({
      selectedText,
      preferences: [{ topic: "Interview quotations", guidance }],
    });
    if (instruction.startsWith("/copyedit ")) {
      expect(input.instruction).toContain("Correct spelling, punctuation, and grammar.");
      expect(input.instruction).toContain(instruction.slice("/copyedit ".length));
    } else expect(input.instruction).toBe(instruction);
    expect(
      messages?.some(
        ({ role, content }) =>
          role === "system" && content.includes("explicit current instruction takes precedence"),
      ),
    ).toBe(true);
  }

  await page.locator(".cm-content:visible").press("ControlOrMeta+A");
  await runMenuItem(page, "edit.rememberWritingPreference");
  await expect(preferences(inline).getByLabel("Remember for")).toBeVisible();
  await remember("Personal default", defaults);
  await remember("Working folder", folderRule);
  await expect(preferences(inline)).toContainText(folderRule);
  await expect(preferences(inline)).not.toContainText(defaults);
  await remember("This task", taskRule);
  await expect(preferences(inline)).toContainText(taskRule);
  await expect(preferences(inline)).not.toContainText(folderRule);
  expect(received).toHaveLength(0);
  const originalTask = "Review these interview notes.";
  await send(inline, originalTask, taskRule, paraphrased);
  await inline.getByRole("button", { name: "Continue in sidebar" }).click();
  await expect(sidebar).toContainText(taskRule);
  await send(sidebar, explicit, taskRule, selectedText);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const preferenceForm = preferences(sidebar);
  await preferenceForm.getByText("Remember a correction", { exact: true }).click();
  await expect(preferenceForm.getByLabel("Writing guidance")).toHaveValue(explicit);
  expect(await questionsAsked(page)).toEqual([]);
  await sidebar.getByRole("button", { name: "Close", exact: true }).click();

  await openSelection();
  await expect(preferences(inline)).toContainText(folderRule);
  await send(
    inline,
    "/copyedit Review the same interview for publication.",
    folderRule,
    selectedText,
  );
  await inline.getByRole("button", { name: "Close", exact: true }).click();

  await runMenuItem(page, "edit.writingTasks");
  await page
    .getByRole("dialog", { name: "Writing tasks" })
    .getByRole("button", { name: originalTask, exact: true })
    .click();
  await expect(preferences(sidebar)).toContainText(taskRule);
  await sidebar.getByRole("button", { name: "Close", exact: true }).click();

  await runMenuItem(page, "file.open");
  await expect(page.getByRole("tab", { name: /brief\.md/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await openSelection();
  await expect(preferences(inline)).toContainText(defaults);
  await send(inline, "Review the unrelated brief.", defaults, standardized);
});

test("reuse a preference saved in Draft with AI from the standalone Agent command", async ({
  page,
}) => {
  const document = "/interviews/review.md";
  const executable = "/fixtures/codex";
  const guidance = "Keep interview quotations verbatim.";
  const endpoint = "https://draft.example.test/v1";
  const calls: { request: { instruction: string; selectedText: string; preferences?: unknown } }[] =
    [];
  let draftInput: unknown;
  await page.route(`${endpoint}/chat/completions`, (route) => {
    const messages = route.request().postDataJSON().messages;
    const input = messages.at(-1).content;
    draftInput = input.startsWith("{") ? JSON.parse(input) : input;
    return route.fulfill({
      json: { choices: [{ message: { content: "A draft with the original quotation." } }] },
    });
  });
  await page.route("**/__test/interview-agent", (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        text:
          calls.length === 1
            ? "Reviewed the quotation."
            : JSON.stringify({
                findings: [{ quote: "It ain't easy.", note: "Keep the original wording." }],
              }),
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    openedPaths: [
      { path: "/interviews", kind: "directory" },
      { path: document, kind: "file" },
    ],
    files: { [document]: 'She said, "It ain\'t easy."' },
    externalAgent: { executables: [executable], endpoint: "/__test/interview-agent" },
  });
  await runMenuItem(page, "file.draftWithAi");
  const draft = page.getByRole("form", { name: "Draft with AI" });
  const draftPreferences = draft.getByRole("group", { name: "Writing preferences to send" });
  await draftPreferences.getByText("Remember a correction", { exact: true }).click();
  await draftPreferences.getByLabel("Remember for").selectOption("folder");
  await draftPreferences.getByLabel("Topic").fill("Interview quotes");
  await draftPreferences.getByLabel("Writing guidance").fill(guidance);
  await draftPreferences.getByRole("button", { name: "Save writing preference" }).click();
  await expect(draftPreferences).toContainText(guidance);
  await draft.getByLabel("API address").fill(endpoint);
  await draft.getByLabel("Model name").fill("first-draft");
  await draft.getByLabel("Drafting instruction").fill("Draft an interview summary.");
  await draft.getByRole("button", { name: "Generate draft", exact: true }).click();
  await expect(page.locator(".cm-content:visible")).toHaveText(
    "A draft with the original quotation.",
  );
  expect(draftInput).toMatchObject({ preferences: [{ topic: "Interview quotes", guidance }] });

  await page.getByRole("tab", { name: "review.md" }).click();
  await page.locator(".cm-content:visible").press("ControlOrMeta+A");
  await runMenuItem(page, "edit.askExternalAgent");
  const agent = page.getByRole("dialog", { name: "Ask External Agent" });
  await agent.getByLabel("Codex executable").fill(executable);
  await agent.getByRole("button", { name: "Inspect Agent" }).click();
  await expect(agent.getByRole("group", { name: "Writing preferences to send" })).toContainText(
    guidance,
  );
  await agent.getByLabel("Instruction", { exact: true }).fill("Review the quotation.");
  await agent.getByRole("button", { name: "Send selection", exact: true }).click();
  await agent.getByRole("button", { name: "Allow and send" }).click();
  await expect(agent.getByText("Reviewed the quotation.", { exact: true }).first()).toBeVisible();
  expect(calls[0]?.request).toMatchObject({
    selectedText: 'She said, "It ain\'t easy."',
    preferences: [{ topic: "Interview quotes", guidance }],
  });
  expect(calls[0]?.request.instruction).toContain("explicit current instruction takes precedence");
  await agent.getByRole("button", { name: "Close", exact: true }).click();

  await runMenuItem(page, "edit.reviewDocument");
  const review = page.getByRole("complementary", { name: "Annotations" });
  await expect(review.getByRole("group", { name: "Writing preferences to send" })).toContainText(
    guidance,
  );
  await review.getByRole("button", { name: /^Comment only ·/ }).click();
  await expect(review.getByText("Keep the original wording.", { exact: true })).toBeVisible();
  expect(calls[1]?.request.preferences).toEqual([{ topic: "Interview quotes", guidance }]);
});
