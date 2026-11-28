import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SavedWritingTask } from "../src/ai/writing-tasks.ts";
import type { MemoryPlatformOptions } from "../src/platform/memory.ts";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

const path = "/notes/manuscript.md";
const endpoint = "https://review.example.test/v1/chat/completions";

async function tabTo(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  for (let index = 0; index < 40; index++) {
    if (await control.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(control).toBeFocused();
}

async function openProposals(
  page: Page,
  source: string,
  replacement: string,
  fixtures?: Pick<MemoryPlatformOptions, "appData" | "files">,
) {
  let requests = 0;
  await page.route(endpoint, (route) => {
    requests++;
    return route.fulfill({
      json: {
        choices: [
          {
            message: { content: `<replacement>${replacement}</replacement>` },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { ...fixtures?.files, [path]: source, [settingsPath]: '{"autosave":false}' },
    appData: fixtures?.appData,
    openedPaths: [{ path, kind: "file" }],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Manuscript fixture");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Manuscript fixture" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
  const editor = page.getByRole("tabpanel").getByRole("textbox");
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Command Palette" }).pressSequentially("Ask AI");
  await page.keyboard.press("Enter");
  const assistant = page.getByRole("region", { name: "Ask AI", exact: true });
  await expect(assistant.getByRole("textbox", { name: "Instruction" })).toBeFocused();
  await page.keyboard.type("Revise the manuscript.");
  await page.keyboard.press("Enter");
  await expect(assistant.getByRole("button", { name: "Review proposed edits" })).toBeVisible();
  return { assistant, editor, sentRequests: () => requests };
}

test("keyboard decisions advance through the manuscript and Escape restores the reading position", async ({
  page,
}) => {
  const tail = Array.from({ length: 65 }, (_, i) => `Background paragraph ${i + 1}.`).join("\n\n");
  const source = `# Methods\n\nOld opening.\n\nKeep these details.\n\nOld method.\n\n# Results\n\nOld result.\n\n${tail}\n\nReading anchor.`;
  const replacement = source
    .replace("Old opening.", "New opening.")
    .replace("Old method.", "New method.")
    .replace("Old result.", "New result.");
  const { assistant, editor } = await openProposals(page, source, replacement);
  await editor.press("ControlOrMeta+End");
  await expect
    .poll(() => page.evaluate(() => getSelection()?.focusNode?.textContent))
    .toBe("Reading anchor.");
  const top = await page.locator(".cm-scroller").evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await tabTo(page, assistant.getByRole("button", { name: "Review proposed edits" }));
  await page.keyboard.press("Enter");

  const review = page.getByRole("dialog", { name: "Review proposed edits" });
  const position = (text: string) => review.getByRole("heading", { name: text, exact: true });
  await expect(position("Replacement · Edit 1 of 3")).toBeFocused();
  await tabTo(page, review.getByRole("button", { name: "Dismiss proposed edit" }));
  await page.keyboard.press("Enter");
  await expect(position("Replacement · Edit 2 of 3")).toBeFocused();
  await tabTo(page, review.getByRole("button", { name: "Leave comment" }));
  await page.keyboard.press("Enter");
  await expect(review.getByRole("textbox", { name: "Review comment" })).toBeFocused();
  await page.keyboard.type("Check this with the research team.");
  await page.keyboard.press("Enter");
  await expect(position("Replacement · Edit 3 of 3")).toBeFocused();
  await tabTo(page, review.getByRole("button", { name: "Apply proposed edit" }));
  await page.keyboard.press("Enter");
  await expect(review.getByRole("heading", { name: "No edits match this view." })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => getSelection()?.focusNode?.textContent))
    .toBe("Reading anchor.");
  await expect
    .poll(() => page.locator(".cm-scroller").evaluate((element) => element.scrollTop))
    .toBeCloseTo(top, 0);
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source.replace("Old result.", "New result."));
});

test("table and formula edits keep their formatting in a stacked comparison with source available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 760 });
  const source =
    "# Results\n\n| Group | Count |\n| --- | --- |\n| Coast | 12 |\n\nTotals follow.\n\n$$\nx = 12\n$$";
  const replacement = source
    .replace("| Coast | 12 |", "| Coast | 17 |")
    .replace("x = 12", "x = 17");
  await openProposals(page, source, replacement);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Command Palette" }).fill("Review proposed edits");
  await expect(page.getByRole("option", { name: "Review Proposed Edits…" })).toBeVisible();
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("button", { name: "Revise the manuscript.", exact: true }));
  await page.keyboard.press("Enter");

  const review = page.getByRole("dialog", { name: "Review proposed edits" });
  await expect(
    review.getByRole("heading", { name: "Table · Replacement · Edit 1 of 2" }),
  ).toBeFocused();
  const removed = review.getByRole("region", { name: "Removed text" });
  const added = review.getByRole("region", { name: "Added text" });
  await expect(removed.getByRole("cell", { name: "12", exact: true })).toBeVisible();
  await expect(added.getByRole("cell", { name: "17", exact: true })).toBeVisible();
  const before = await removed.boundingBox();
  const after = await added.boundingBox();
  expect(after?.y).toBeGreaterThan((before?.y ?? 0) + (before?.height ?? 0));

  const sourceToggle = review.getByRole("checkbox", { name: "Show Markdown source" });
  await tabTo(page, sourceToggle);
  await page.keyboard.press("Space");
  await expect(removed.getByText("| Coast | 12 |", { exact: true })).toBeVisible();
  await expect(added.getByText("| Coast | 17 |", { exact: true })).toBeVisible();
  await expect(review.getByRole("table")).toHaveCount(0);
  await page.keyboard.press("Space");

  await tabTo(page, review.getByRole("button", { name: "Next edit" }));
  await page.keyboard.press("Enter");
  await expect(
    review.getByRole("heading", { name: "Formula · Replacement · Edit 2 of 2" }),
  ).toBeFocused();
  await expect(removed.locator(".katex")).toBeVisible();
  await expect(added.locator(".katex")).toBeVisible();
  await tabTo(page, sourceToggle);
  await page.keyboard.press("Space");
  await expect(added.getByText("x = 17", { exact: true })).toBeVisible();
});

test("section acceptance preserves prior decisions and can be undone in one editor command", async ({
  page,
}) => {
  const source =
    "# Methods\n\nOld opening.\n\nOld detail.\n\nOld context.\n\nKeep this protocol.\n\nOld sample.\n\nKeep these units.\n\nOld measure.\n\n# Results\n\nOld result.";
  const replacement = source.replaceAll("Old ", "New ").replace("New sample.\n\n", "");
  const { assistant, editor } = await openProposals(page, source, replacement);
  await tabTo(page, assistant.getByRole("button", { name: "Review proposed edits" }));
  await page.keyboard.press("Enter");
  const review = page.getByRole("dialog", { name: "Review proposed edits" });
  const dismiss = review.getByRole("button", { name: "Dismiss proposed edit" });
  await tabTo(page, dismiss);
  await page.keyboard.press("Enter");
  await tabTo(page, dismiss);
  await page.keyboard.press("Enter");
  await tabTo(page, review.getByRole("button", { name: "Leave comment" }));
  await page.keyboard.press("Enter");
  await page.keyboard.type("Confirm this detail.");
  await page.keyboard.press("Enter");

  const section = review.getByRole("combobox", { name: "Section" });
  await expect(
    section.getByRole("option", { name: "Methods · 2 pending of 5 edits" }),
  ).toBeAttached();
  await tabTo(page, section);
  await page.keyboard.press("m");
  const accept = review.getByRole("button", { name: "Accept remaining edits in Methods" });
  await tabTo(page, accept);
  await page.keyboard.press("Enter");
  await expect(review.getByRole("heading", { name: "No edits match this view." })).toBeFocused();
  await expect(review.getByRole("status")).toHaveText("Accepted 2 edits.");

  const status = review.getByRole("combobox", { name: "Review status" });
  await tabTo(page, status);
  await page.keyboard.press("a");
  await expect(review.getByText("Proposed edit dismissed.")).toBeVisible();
  await expect(review.getByText("Old opening.", { exact: true })).toBeVisible();
  const next = review.getByRole("button", { name: "Next edit" });
  for (let index = 0; index < 2; index++) {
    await tabTo(page, next);
    await page.keyboard.press("Enter");
  }
  await expect(review.getByText("Confirm this detail.", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+S");
  const accepted = source.replace("Old sample.\n\n", "").replace("Old measure.", "New measure.");
  await expect.poll(() => readFile(page, path)).toBe(accepted);
  await page.getByRole("button", { name: "Open manuscript.md in other pane" }).click();
  const peer = page.getByRole("tabpanel", { name: "manuscript.md" }).last().getByRole("textbox");
  await expect(peer).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source);
  await page.getByRole("button", { name: "Close manuscript.md", exact: true }).last().click();
  await expect(editor).toBeFocused();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Command Palette" }).fill("All writing tasks");
  await page.keyboard.press("Enter");
  const history = page.getByRole("dialog", { name: "All writing tasks" });
  await expect(
    history.getByRole("listitem").filter({ hasText: "Revise the manuscript." }),
  ).toContainText("4 decisions needed");
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(accepted);
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source);

  await tabTo(page, page.getByRole("button", { name: "Resume conversation" }));
  await page.keyboard.press("Enter");
  await tabTo(page, assistant.getByRole("button", { name: "Review proposed edits" }));
  await page.keyboard.press("Enter");
  await expect(review.getByRole("heading", { name: "Deletion · Edit 4 of 6" })).toBeFocused();
  await expect(review.getByRole("button", { name: "Apply proposed edit" })).toBeVisible();

  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Command Palette" }).fill("All writing tasks");
  await page.keyboard.press("Enter");
  await tabTo(page, history.getByRole("button", { name: "Revise the manuscript.", exact: true }));
  await page.keyboard.press("Enter");
  const task = page.getByRole("complementary", { name: "Writing Assistant" });
  const opening = task.getByRole("group", { name: "Proposed edit 1 of 6" });
  const detail = task.getByRole("group", { name: "Proposed edit 2 of 6" });
  const context = task.getByRole("group", { name: "Proposed edit 3 of 6" });
  await tabTo(page, detail.getByRole("button", { name: "Return to pending" }));
  await page.keyboard.press("Enter");
  await expect(detail.getByRole("button", { name: "Apply proposed edit" })).toBeVisible();
  await expect(opening).toContainText("Proposed edit dismissed.");
  await expect(context).toContainText("Confirm this detail.");
  expect(await readFile(page, path)).toBe(source);
});

test("a proposal returned to pending by section undo follows replacement typing", async ({
  page,
}) => {
  const source = "# Methods\n\nOld opening.\n\nKeep this.\n\nOld result.";
  const replacement = source.replaceAll("Old ", "New ");
  const { assistant, editor } = await openProposals(page, source, replacement);
  await assistant.getByRole("button", { name: "Review proposed edits" }).click();
  const review = page.getByRole("dialog", { name: "Review proposed edits" });
  await review.getByRole("combobox", { name: "Section" }).selectOption({
    label: "Methods · 2 pending of 2 edits",
  });
  await review.getByRole("button", { name: "Accept remaining edits in Methods" }).click();
  await expect(review.getByRole("status")).toHaveText("Accepted 2 edits.");
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await editor.press("ControlOrMeta+Z");

  const authored = "Author's result.";
  await editor.getByText("Old result.", { exact: true }).click();
  await editor.press("End");
  await editor.press("Shift+Home");
  await page.keyboard.type(authored);
  await page.getByRole("button", { name: "Resume conversation", exact: true }).click();
  const proposal = assistant.getByRole("group", { name: "Proposed edit 2 of 2" });
  await expect(proposal.getByText(authored, { exact: true })).toBeVisible();
  await proposal.getByRole("button", { name: "Apply to compared text" }).click();
  await expect(editor).toBeFocused();
  await editor.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source.replace("Old result.", "New result."));
});

test("section acceptance leaves a proposal spanning two sections for individual review", async ({
  page,
}) => {
  const source = "# Methods\n\nOld opening.\n\nOld sample.\n# Results\n\nKeep this result.";
  const replacement = "# Methods\n\nNew opening.\n\nNew sample.\n# Findings\n\nKeep this result.";
  const { assistant } = await openProposals(page, source, replacement);
  await assistant.getByRole("button", { name: "Review proposed edits" }).click();
  const review = page.getByRole("dialog", { name: "Review proposed edits" });
  await review
    .getByRole("combobox", { name: "Section" })
    .selectOption({ label: "Methods · 2 pending of 2 edits" });
  await review.getByRole("button", { name: "Accept remaining edits in Methods" }).click();
  await expect(review.getByRole("status")).toHaveText("Accepted 1 edit.");
  await expect(review.getByRole("button", { name: "Apply proposed edit" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe(source.replace("Old opening.", "New opening."));
});

test("saved proposals can be opened by file and closing returns to the original manuscript", async ({
  page,
}) => {
  const other = "/notes/appendix.md";
  const original = "Old appendix.\n\nOld appendix detail.";
  const first = { from: 0, to: "Old appendix.".length, located: true };
  const second = {
    from: original.indexOf("Old appendix detail."),
    to: original.length,
    located: true,
  };
  const saved: SavedWritingTask = {
    version: 1,
    id: "a437fb3f-12cc-4491-9fe0-f4802ab78622",
    title: "Review the appendix",
    path: other,
    folder: "/notes",
    updatedAt: 1,
    baseline: original,
    origin: { from: 0, to: original.length, located: true, text: original },
    reading: { anchor: 0, head: 0, top: 0 },
    reviewScroll: 0,
    reviewSelection: `0:${second.from}`,
    showSource: false,
    turns: [
      {
        instruction: "Review the appendix",
        reply: "",
        recipient: "Original model",
        recipientId: "model:original",
        direct: false,
        suggestions: [
          {
            id: 0,
            before: "Old appendix.",
            after: "New appendix.",
            status: "preview",
            range: first,
          },
          {
            id: second.from,
            before: "Old appendix detail.",
            after: "New appendix detail.",
            status: "preview",
            range: second,
          },
        ],
      },
    ],
  };
  const paragraphs = Array.from({ length: 45 }, () => "Background from the field notes.");
  const manuscript = ["Old body.", ...paragraphs, "Original reading position."].join("\n\n");
  const { assistant, editor, sentRequests } = await openProposals(
    page,
    manuscript,
    manuscript.replace("Old body.", "New body."),
    {
      files: { [other]: original },
      appData: { [`ai/tasks/${saved.id}/review.json`]: JSON.stringify(saved) },
    },
  );
  await editor.press("ControlOrMeta+End");
  const readingLine = () => page.evaluate(() => getSelection()?.focusNode?.textContent);
  await expect.poll(readingLine).toBe("Original reading position.");
  const scrollTop = () => page.locator(".cm-scroller:visible").evaluate((node) => node.scrollTop);
  const top = await scrollTop();
  expect(top).toBeGreaterThan(0);
  await tabTo(page, assistant.getByRole("button", { name: "Review proposed edits" }));
  await page.keyboard.press("Enter");

  const review = page.getByRole("dialog", { name: "Review proposed edits" });
  await review
    .getByRole("combobox", { name: "File", exact: true })
    .selectOption({ label: "appendix.md" });
  await tabTo(page, review.getByRole("button", { name: "Open file review" }));
  await page.keyboard.press("Enter");
  await expect(review.getByText("New appendix detail.", { exact: true })).toBeVisible();
  await expect(review.getByRole("heading", { name: "Replacement · Edit 2 of 2" })).toBeFocused();
  expect(sentRequests()).toBe(1);
  expect(await readFile(page, other)).toBe(original);

  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(
    page.getByRole("tabpanel", { name: "manuscript.md" }).getByRole("textbox"),
  ).toBeFocused();
  await expect.poll(readingLine).toBe("Original reading position.");
  await expect.poll(scrollTop).toBeCloseTo(top, 0);
});
