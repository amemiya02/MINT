import { expect, test } from "@playwright/test";
import type { SavedWritingTask } from "../src/ai/writing-tasks.ts";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import { launch, readFile, runMenuItem, settingsPath, writeFile } from "./memory-platform.ts";

const path = "/notes/review.md";
const endpoint = "https://review.example.test/v1/chat/completions";
const instruction = "Review the four passages.";
type MintWindow = { __MINT_MEMORY_PLATFORM__: MemoryPlatform };

test("a resumed suggestion remains applicable after edits on both sides of it", async ({
  page,
}) => {
  const initialParagraph = "The opening paragraph has a separate proofreading passage.";
  const baseline = `${initialParagraph}\r\n\r\nthe intro target tail.`;
  const changed = `${initialParagraph}\n\nThe intro target TAIL.`;
  const from = baseline.indexOf("target");
  const range = { from, to: from + "target".length, located: true };
  const task: SavedWritingTask = {
    version: 1,
    id: "d52260cd-9b04-43d7-a040-e39f529b5501",
    path,
    title: "Revise the target word.",
    updatedAt: 1,
    baseline,
    origin: { ...range, text: "target" },
    reading: { anchor: range.from, head: range.from, top: 0 },
    reviewScroll: 0,
    showSource: false,
    turns: [
      {
        instruction: "Revise the target word.",
        reply: "replacement",
        recipient: "Original model",
        recipientId: "model:original",
        direct: false,
        suggestions: [{ id: 0, before: "target", after: "replacement", status: "preview", range }],
      },
    ],
  };
  await launch(page, {
    locale: "en-US",
    files: { [path]: changed, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
    appData: { [`ai/tasks/${task.id}/review.json`]: JSON.stringify(task) },
  });
  const passages: string[] = [];
  await page.route(endpoint, (route) => {
    const request = route.request().postDataJSON();
    passages.push(JSON.parse(request.messages[0].content).selectedText);
    return route.fulfill({ json: { choices: [{ message: { content: "null" } }] } });
  });
  const model = await page.evaluate(async (address) => {
    return (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.saveModelConnection({
      name: "Replacement model",
      address,
      model: "fixture-model",
      apiKey: "",
      lifetime: "session",
    });
  }, endpoint);
  await writeFile(
    page,
    settingsPath,
    JSON.stringify({ autosave: false, proofreading: true, proofreadingModel: model.id }),
  );
  await expect.poll(() => passages).toEqual([initialParagraph]);
  await runMenuItem(page, "edit.writingTasks");
  await page.getByRole("button", { name: task.title, exact: true }).click();

  const assistant = page.getByRole("complementary", { name: "Writing Assistant" });
  await expect(assistant).toBeVisible();
  // Allow the proofreading debounce to elapse before author input changes the document.
  await page.waitForTimeout(1000);
  expect(passages).toEqual([initialParagraph]);
  const recipient = assistant.getByRole("combobox", { name: "Recipient" });
  const replacementModel = `Replacement model · ${endpoint}`;
  await expect(recipient.locator("option", { hasText: replacementModel })).toHaveCount(1);
  await expect(recipient).toHaveValue("");
  await recipient.selectOption({ label: replacementModel });
  await expect(
    assistant.getByLabel("Send earlier instructions and replies with this message"),
  ).not.toBeChecked();
  const apply = assistant.getByRole("button", { name: "Apply proposed edit", exact: true });
  await apply.click();
  await expect(page.locator(".cm-content")).toContainText("The intro replacement TAIL.");

  await runMenuItem(page, "view.openInOtherPane");
  await expect(page.getByRole("tabpanel")).toHaveCount(2);
  await runMenuItem(page, "edit.writingTasks");
  await page.getByRole("button", { name: task.title, exact: true }).click();
  await expect(assistant).toHaveCount(1);
  await expect(assistant.getByRole("group", { name: "Proposed edit 1 of 1" })).toContainText(
    "Applied",
  );
  await assistant.getByRole("button", { name: "Revert this edit" }).click();
  await expect(page.getByRole("tabpanel").nth(0).locator(".cm-content")).toContainText(
    "The intro target TAIL.",
  );
  await expect(page.getByRole("tabpanel").nth(1).locator(".cm-content")).toContainText(
    "The intro target TAIL.",
  );
  await expect(assistant.getByRole("button", { name: "Revert this edit" })).toHaveCount(0);
  await page.locator(".cm-content").nth(1).press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(changed);
});

test("a writing task resumes decisions, materials and reading position after a restart", async ({
  page,
  browser,
}) => {
  const unchanged = Array.from({ length: 60 }, (_, i) => `Background paragraph ${i + 1}.`).join(
    "\n\n",
  );
  const source = ["First draft.", "Second draft.", "Third draft.", unchanged, "Last draft."].join(
    "\n\n",
  );
  const replacement = [
    "First revision.",
    "Second revision.",
    "Third revision.",
    unchanged,
    "Last revision.",
  ].join("\n\n");
  let calls = 0;
  await page.route(endpoint, (route) => {
    calls++;
    if (calls === 1) expect(route.request().postData()).toContain("Field notes from Tuesday.");
    return route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: `<replacement>${replacement}</replacement>`,
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  const seed = {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" as const }],
  };
  await launch(page, seed);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Review fixture");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Review fixture" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();

  const editor = page.locator(".cm-content");
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const review = page.getByRole("region", { name: "Ask AI" });
  await review.getByText("Add files or paste text", { exact: true }).click();
  await review.getByRole("textbox", { name: "Pasted material" }).fill("Field notes from Tuesday.");
  await review.getByRole("button", { name: "Add pasted text", exact: true }).click();
  await review.getByRole("textbox", { name: "Instruction" }).fill(instruction);
  await review.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await review
    .getByRole("group", { name: "Proposed edit 1 of 4" })
    .getByRole("button", { name: "Apply proposed edit", exact: true })
    .click();
  await review
    .getByRole("group", { name: "Proposed edit 2 of 4" })
    .getByRole("button", { name: "Dismiss proposed edit" })
    .click();
  await editor.press("ControlOrMeta+End");
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((view) => view.scrollTop))
    .toBeGreaterThan(0);
  await editor.press("ControlOrMeta+S");
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await review.getByRole("textbox", { name: "Instruction" }).fill("Keep this other task.");
  await review.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect(review.getByRole("button", { name: "Continue in sidebar" })).toBeVisible();
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Writing tasks", exact: true }).click();
  await expect(page.getByRole("button", { name: instruction, exact: true })).toBeVisible();

  const renamedPath = "/notes/renamed-review.md";
  const appData = await page.evaluate(
    async ([from, to]) => {
      const platform = (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__;
      await platform.rename(from, to);
      return Object.fromEntries(platform.appData);
    },
    [path, renamedPath] as const,
  );
  const rebooted = await browser.newContext();
  try {
    await rebooted.route(endpoint, (route) => {
      calls++;
      return route.abort();
    });
    const resumed = await rebooted.newPage();
    const changed =
      "New opening note.\n\n" +
      source
        .replace("First draft.", "First revision.")
        .replace("Third draft.", "Externally changed third.");
    await launch(resumed, {
      ...seed,
      appData,
      openedPaths: [{ path: renamedPath, kind: "file" }],
      files: { [renamedPath]: changed, [settingsPath]: seed.files[settingsPath] },
    });
    await runMenuItem(resumed, "edit.writingTasks");
    await resumed.getByRole("button", { name: instruction, exact: true }).click();

    const assistant = resumed.getByRole("complementary", { name: "Writing Assistant" });
    const edit = (position: number) =>
      assistant.getByRole("group", {
        name: `Proposed edit ${position} of 4`,
      });
    await expect(edit(1)).toContainText("Applied");
    await expect(edit(2)).toContainText("Proposed edit dismissed.");
    await expect(edit(3).getByText("Externally changed third.", { exact: true })).toBeVisible();
    await expect(edit(3).getByRole("button", { name: "Apply to compared text" })).toBeVisible();
    await expect(
      edit(4).getByRole("button", { name: "Apply proposed edit", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => resumed.locator(".cm-scroller").evaluate((view) => view.scrollTop))
      .toBeGreaterThan(0);
    await assistant.getByText("Pasted text", { exact: true }).click();
    await expect(assistant.getByText("Field notes from Tuesday.", { exact: true })).toBeVisible();
    await assistant.getByRole("button", { name: "Close", exact: true }).click();
    expect(await resumed.evaluate(() => window.getSelection()?.focusNode?.textContent)).toBe(
      "Last draft.",
    );
    expect(calls).toBe(2);

    await resumed.getByRole("button", { name: "Writing tasks", exact: true }).click();
    const dialog = resumed.getByRole("dialog", { name: "Writing tasks" });
    const remove = dialog.getByRole("button", { name: `Delete ${instruction}`, exact: true });
    await expect(remove).toBeVisible({ timeout: 4000 });
    await remove.click();
    await dialog.getByRole("button", { name: "Delete task", exact: true }).click();
    await expect(dialog.getByRole("button", { name: instruction, exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Keep this other task.", exact: true }),
    ).toBeVisible();
    expect(await readFile(resumed, renamedPath)).toBe(changed);
    const preserved = await resumed.evaluate(async (path) => {
      const platform = (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__;
      const [id] = await platform.listVersions(path);
      return {
        version: id === undefined ? null : await platform.readVersion(path, id),
        privateData: JSON.stringify(Object.fromEntries(platform.appData)),
      };
    }, renamedPath);
    expect(preserved.version).toContain("First revision.");
    expect(preserved.privateData).not.toContain("Field notes from Tuesday.");
    expect(calls).toBe(2);
  } finally {
    await rebooted.close();
  }
});
