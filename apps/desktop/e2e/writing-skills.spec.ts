import { expect, test } from "@playwright/test";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

test("inspect a slash skill and override its working-folder action for one task", async ({
  page,
}) => {
  const draft = "/book/chapter.md";
  const other = "/book-two/chapter.md";
  const original = "The team are ready.";
  const revised = "The team is ready.";
  const endpoint = "https://skills.example.test/v1/chat/completions";
  const requests: { instruction: string; selectedText: string; taskContext?: unknown }[] = [];
  await page.route(endpoint, (route) => {
    const { messages } = route.request().postDataJSON();
    requests.push(JSON.parse(messages.at(-1).content));
    const editing = messages.some(({ content }: { content: string }) =>
      content.includes("<replacement>"),
    );
    return route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: editing ? `<replacement>${revised}</replacement>` : "Check verb agreement.",
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [draft]: original, [other]: original, [settingsPath]: '{"autosave":false}' },
    openedPaths: [
      { path: "/book", kind: "directory" },
      { path: draft, kind: "file" },
    ],
    openFolderDialogResults: ["/book-two"],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Skill fixture");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Skill fixture" })).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();

  const editor = page.locator(".cm-content:visible");
  const composer = page.getByRole("region", { name: "Ask AI" });
  const instruction = composer.getByRole("textbox", { name: "Instruction" });
  const action = composer.getByLabel("Action");
  const plan = composer.getByRole("group", { name: "Writing skill plan" });
  async function ask() {
    await editor.press("ControlOrMeta+A");
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  }
  const close = () => composer.getByRole("button", { name: "Close", exact: true }).click();

  await ask();
  await instruction.fill("/cop");
  await expect(composer.getByRole("button", { name: "/copyedit · Copyedit" })).toBeVisible();
  await composer.getByRole("button", { name: "/copyedit · Copyedit" }).click();
  await expect(plan).toContainText("Correct spelling, punctuation, and grammar.");
  await expect(plan).toContainText("Preserve the author's meaning, voice, and Markdown structure.");
  await expect(composer.getByRole("group", { name: "Task context to send" })).toContainText(
    original,
  );
  await expect(composer.getByText("MCP tools", { exact: true })).toBeVisible();
  await expect(plan).toContainText("No tools required");
  await action.selectOption({ label: "Comment only" });
  await plan.getByRole("button", { name: "Remember this action for /book", exact: true }).click();
  await expect(plan).toContainText("Remembered for /book · Comment only");
  expect(requests).toEqual([]);
  await composer
    .getByRole("button", { name: /Comment only · Current selection · Skill fixture/ })
    .click();
  await expect(composer.getByRole("textbox", { name: "AI reply", exact: true })).toHaveValue(
    "Check verb agreement.",
  );
  await expect(editor).toHaveText(original);

  await close();
  await ask();
  await instruction.fill("/copyedit Keep the team as the subject.");
  await expect(action).toHaveValue("comment");
  await action.selectOption({ label: "Apply directly" });
  await expect(plan).toContainText("Remembered for /book · Comment only");
  await expect(
    composer.getByRole("button", { name: /Apply directly · Current selection/ }),
  ).toBeEnabled();
  await instruction.press("Enter");
  await expect(editor).toHaveText(revised);
  expect(await readFile(page, draft)).toBe(original);
  await close();

  await editor.press("ControlOrMeta+A");
  await runMenuItem(page, "edit.writingSkills");
  await expect(composer.getByRole("group", { name: "Writing skills" })).toBeVisible();
  await composer.getByRole("button", { name: "/copyedit · Copyedit" }).click();
  await expect(action).toHaveValue("comment");
  await instruction.fill("/clarify");
  await expect(action).toHaveValue("preview");
  await close();

  await runMenuItem(page, "file.openFolder");
  await expect(page.getByText("book-two", { exact: true })).toBeVisible();
  await page.getByRole("treeitem", { name: "chapter.md", exact: true }).click();
  await ask();
  await instruction.fill("/copyedit");
  await expect(plan).toContainText("No remembered action for /book-two");
  await expect(action).toHaveValue("preview");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ selectedText: original });
  expect(requests[0]?.instruction).toContain("Correct spelling, punctuation, and grammar.");
  expect(requests[0]?.instruction).toContain("Give comments only.");
  expect(requests[1]).toMatchObject({ selectedText: original });
  expect(requests[1]?.instruction).toContain("Correct spelling, punctuation, and grammar.");
  expect(requests[1]?.instruction).toContain("Keep the team as the subject.");
  expect(requests[1]?.instruction).toContain("Return the revised text.");
});
