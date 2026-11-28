import { expect, test } from "@playwright/test";
import type { SavedWritingTask } from "../src/ai/writing-tasks.ts";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

const path = "/notes/temporary-review.md";
const otherPath = "/notes/other-review.md";
const endpoint = "https://temporary.example.test/v1/chat/completions";
const original =
  "The team discussed the result.\n\nKeep these bytes.  \n\nThe group reached a conclusion.";
const revised = "The team met.\n\nKeep these bytes.  \n\nThe group decided.";
const retained = "The team discussed the result.\n\nKeep these bytes.  \n\nThe group decided.";
const instruction = "Shorten the two sentences, apply directly";
const material = "Private interview excerpt for the temporary task.";
const savedTask: SavedWritingTask = {
  version: 1,
  id: "22b21885-47e5-456e-8314-3f84835cccbb",
  path,
  title: "An ordinary writing review",
  updatedAt: 1,
  baseline: original,
  origin: { from: 0, to: original.length, text: original, located: true },
  reading: { anchor: 0, head: 0, top: 0 },
  reviewScroll: 0,
  showSource: false,
  turns: [
    {
      instruction: "Review the opening sentence",
      reply: "",
      recipient: "Fixture model",
      recipientId: "model:fixture",
      direct: false,
      suggestions: [
        {
          id: 0,
          before: "The team discussed the result.",
          after: "The team met.",
          status: "preview",
          range: { from: 0, to: "The team discussed the result.".length, located: true },
        },
      ],
    },
  ],
};
const otherTask: SavedWritingTask = {
  ...savedTask,
  id: "a437fb3f-12cc-4491-9fe0-f4802ab78622",
  path: otherPath,
  title: "Review the other draft",
};
type MintWindow = { __MINT_MEMORY_PLATFORM__: MemoryPlatform };

test("a temporary session allows selective reversion before clearing its review and materials", async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route(endpoint, (route) => {
    const { messages } = route.request().postDataJSON();
    requests.push(JSON.parse(messages.at(-1).content));
    return route.fulfill({
      json: {
        choices: [
          { message: { content: `<replacement>${revised}</replacement>` }, finish_reason: "stop" },
        ],
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [path]: original, [otherPath]: original, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
    openDialogResults: [otherPath],
    appData: {
      [`ai/tasks/${savedTask.id}/review.json`]: JSON.stringify(savedTask),
      [`ai/tasks/${otherTask.id}/review.json`]: JSON.stringify(otherTask),
    },
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Temporary fixture");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  const connection = settings.getByRole("region", { name: "Temporary fixture" });
  await expect(connection).toBeVisible();
  const retention = connection.getByText("Data retention", { exact: true });
  await expect(retention).toBeVisible({ timeout: 2500 });
  await retention.click();
  await expect(
    connection.getByText("Retention depends on the configured service.", { exact: false }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();

  const editor = page.locator(".cm-content");
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const composer = page.getByRole("region", { name: "Ask AI", exact: true });
  await composer.getByLabel("Temporary session").check();
  await composer.getByText("Add files or paste text", { exact: true }).click();
  await composer.getByRole("textbox", { name: "Pasted material" }).fill(material);
  await composer.getByRole("button", { name: "Add pasted text" }).click();
  const input = composer.getByRole("textbox", { name: "Instruction" });
  await input.fill(instruction);
  await input.press("Enter");
  await expect(editor).toContainText("The group decided.");
  expect(requests).toEqual([
    {
      instruction,
      selectedText: original,
      taskContext: { materials: [{ name: "Pasted text", text: material }] },
    },
  ]);

  const confirm = page.getByRole("dialog", { name: "Close temporary session" });
  await composer.getByRole("button", { name: "Close temporary session" }).click();
  await expect(confirm).toContainText(
    "keeps edits already made to the draft and its version history",
  );
  await expect(confirm).toContainText("You will lose the option to revert edits by task.");
  await confirm.getByRole("button", { name: "View changes" }).click();
  const review = page.getByRole("complementary", { name: "Writing Assistant" });
  const first = review.getByRole("group", { name: "Proposed edit 1 of 2" });
  await expect(first.getByText("The team discussed the result.", { exact: true })).toBeVisible();
  await expect(first.getByText("The team met.", { exact: true })).toBeVisible();
  await first.getByRole("button", { name: "Revert this edit" }).click();
  await expect(editor).toContainText("The team discussed the result.");
  await editor.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(retained);

  const storedTasks = () =>
    page.evaluate(() =>
      (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.writingTasks.list(null, true),
    );
  expect(JSON.stringify(await storedTasks())).not.toContain(material);
  const versions = () =>
    page.evaluate(async (file) => {
      const platform = (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__;
      return Promise.all(
        (await platform.listVersions(file)).map((id) => platform.readVersion(file, id)),
      );
    }, path);
  const history = await versions();
  expect(history).toContain(retained);
  await runMenuItem(page, "tab.close");
  await expect(confirm).toBeVisible({ timeout: 2500 });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(review.getByRole("button", { name: "Revert this edit" })).toHaveCount(1);

  await review.getByRole("button", { name: "Review proposed edits", exact: true }).click();
  const focusedReview = page.getByRole("dialog", { name: "Review proposed edits" });
  await expect(focusedReview).toBeVisible();
  const closingWindow = page.evaluate(async () => {
    const platform = (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__;
    await platform.closeWindow();
    return platform.closed;
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(await closingWindow).toBe(false);
  await focusedReview.getByRole("button", { name: "Close", exact: true }).click();

  await runMenuItem(page, "edit.writingTasks");
  const historyDialog = page.getByRole("dialog", { name: "Writing tasks", exact: true });
  await historyDialog.getByRole("button", { name: savedTask.title, exact: true }).click();
  await expect(historyDialog.getByRole("alert")).toContainText(
    "Close the temporary session before opening a saved task in this pane.",
  );
  await historyDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(review.getByRole("button", { name: "Revert this edit" })).toHaveCount(1);

  await runMenuItem(page, "file.open");
  await expect(page.getByRole("tab", { name: "other-review.md", selected: true })).toBeVisible();
  await runMenuItem(page, "edit.reviewProposedEdits");
  await focusedReview.getByRole("button", { name: otherTask.title, exact: true }).click();
  await focusedReview
    .getByRole("combobox", { name: "File", exact: true })
    .selectOption({ label: "temporary-review.md" });
  await focusedReview.getByRole("button", { name: "Open file review" }).click();
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText("other-review.md");
  await expect(focusedReview.getByRole("alert")).toContainText(
    "Close the temporary session before opening a saved task in this pane.",
  );
  await focusedReview.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: "temporary-review.md" }).click();
  await expect(review.getByRole("button", { name: "Revert this edit" })).toHaveCount(1);
  await review.getByRole("button", { name: "Close temporary session" }).click();
  await confirm.getByRole("button", { name: "Close temporary session" }).click();

  await expect(review).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume conversation" })).toHaveCount(0);
  await runMenuItem(page, "edit.allWritingTasks");
  const allTasks = page.getByRole("dialog", { name: "All writing tasks" });
  await expect(allTasks.getByRole("button", { name: savedTask.title, exact: true })).toBeVisible();
  await expect(allTasks.getByRole("button", { name: instruction, exact: true })).toHaveCount(0);
  expect(await readFile(page, path)).toBe(retained);
  const data = await storedTasks();
  expect(JSON.stringify(data)).not.toContain(instruction);
  expect(JSON.stringify(data)).not.toContain(material);
  expect(await versions()).toEqual(history);
  expect(requests).toHaveLength(1);
});
