import { expect, type Page, test } from "@playwright/test";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

const path = "/notes/quick-edit.md";
const endpoint = "http://127.0.0.1:9876/v1/chat/completions";
const instruction = "缩短一半，直接改";

async function openManuscript(page: Page, source: string, autosave: boolean) {
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: JSON.stringify({ autosave }) },
    openedPaths: [{ path, kind: "file" }],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Quick edit fixture");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Quick edit fixture" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
}

function replacementReply(replacement: string) {
  return {
    choices: [
      { message: { content: `<replacement>${replacement}</replacement>` }, finish_reason: "stop" },
    ],
  };
}

test("one Enter edits the live selection, keeps both panes usable, and saves and undoes exact bytes", async ({
  page,
}) => {
  const opening = "Keep the opening.  ";
  const ending = "The team discussed the result.";
  const live = "The team discussed the result again.";
  const shortened = "The team met.";
  const middle = Array.from({ length: 70 }, (_, index) => `Section ${index}.`).join("\n\n");
  const source = `\uFEFF${opening}\r\n\r\n${middle}\n\n${ending}`;
  const requests: unknown[] = [];
  await page.route(endpoint, (route) => {
    const { messages } = route.request().postDataJSON();
    requests.push(JSON.parse(messages.at(-1).content));
    return route.fulfill({ json: replacementReply(shortened) });
  });
  await openManuscript(page, source, false);

  const left = page.locator(".cm-content").first();
  await expect(left).toBeFocused();
  await page.getByRole("button", { name: "Open quick-edit.md in other pane" }).click();
  const right = page.locator(".cm-content").nth(1);
  await expect(right).toBeFocused();
  await expect(right.getByText("Keep the opening.", { exact: true })).toBeInViewport();
  await page.getByRole("tab", { name: "quick-edit.md" }).first().click();
  await expect(left).toBeFocused();
  await left.press("ControlOrMeta+End");
  await left.press("Shift+Home");
  await page.keyboard.insertText(live);
  await left.press("Shift+Home");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const composer = page.getByRole("region", { name: "Ask AI", exact: true });
  const input = composer.getByRole("textbox", { name: "Instruction" });
  await input.fill(instruction);
  await expect(
    composer.getByRole("button", {
      name: `Apply directly · Current selection · Quick edit fixture · ${endpoint}`,
      exact: true,
    }),
  ).toBeEnabled();
  await input.press("Enter");

  await expect(left).toBeFocused();
  await expect(left.getByText(shortened, { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
  await expect(right.getByText("Keep the opening.", { exact: true })).toBeInViewport();
  expect(requests).toEqual([{ instruction, selectedText: live }]);
  expect(await readFile(page, path)).toBe(source);

  await page.getByRole("button", { name: "View changes", exact: true }).click();
  const review = page.getByRole("complementary", { name: "Writing Assistant" });
  const comparison = review.getByRole("group", { name: "Proposed edit 1 of 1" });
  await expect(comparison.getByText(live, { exact: true })).toBeVisible();
  await expect(comparison.getByText(shortened, { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(left).toBeFocused();
  await left.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source.replace(ending, shortened));

  await page.getByRole("tab", { name: "quick-edit.md" }).nth(1).click();
  await expect(right).toBeFocused();
  await right.press("ControlOrMeta+End");
  await expect(right.getByText(shortened, { exact: true })).toBeInViewport();
  await right.press("ControlOrMeta+Z");
  await right.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source.replace(ending, live));
  await expect(left.getByText(live, { exact: true })).toBeInViewport();
});

test("autosave writes independent changes and leaves a concurrent edit for comparison", async ({
  page,
}) => {
  const source =
    "\uFEFFOpening line.\nExtra opening detail.\r\n\r\nMiddle line.\n\nKeep these spaces.  \r\n\r\nClosing line.\nClosing detail.\r\n";
  const author = source.replace("Middle line.", "Author's middle line.");
  const expected = author
    .replace("Opening line.\nExtra opening detail.", "Short opening.")
    .replace("Closing line.\nClosing detail.", "Short close.\nShort detail.");
  let releaseReply!: () => void;
  const pending = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  const requests: unknown[] = [];
  await page.route(endpoint, async (route) => {
    const { messages } = route.request().postDataJSON();
    requests.push(JSON.parse(messages.at(-1).content));
    await pending;
    return route.fulfill({
      json: replacementReply(
        "Short opening.\n\nModel's middle line.\n\nKeep these spaces.  \n\nShort close.\nShort detail.\n",
      ),
    });
  });
  await openManuscript(page, source, true);
  await page.getByRole("button", { name: "Track changes", exact: true }).click();
  const trackedChanges = page.getByRole("region", { name: "Tracked changes" });
  const trackedEdits = trackedChanges.getByRole("button", { name: "Reject", exact: true });

  const editor = page.locator(".cm-content");
  await expect(editor).toBeFocused();
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Instruction" });
  await input.fill(instruction);
  await input.press("Enter");
  await expect.poll(() => requests).toEqual([{ instruction, selectedText: source.slice(1) }]);

  await editor.getByText("Middle line.", { exact: true }).click();
  await editor.press("Home");
  await editor.press("Shift+End");
  await page.keyboard.insertText("Author's middle line.");
  releaseReply();
  await expect(page.getByRole("status")).toHaveText("2 edits applied · 1 to review");
  await expect.poll(() => readFile(page, path)).toBe(expected);
  await expect(trackedEdits).toHaveCount(3);

  await page.getByRole("button", { name: "View changes", exact: true }).click();
  const review = page.getByRole("complementary", { name: "Writing Assistant" });
  const conflict = review.getByRole("group", { name: "Proposed edit 2 of 3" });
  await expect(conflict.getByText("Author's middle line.", { exact: true })).toBeVisible();
  await expect(conflict.getByRole("button", { name: "Apply to compared text" })).toBeVisible();
  await review.getByRole("button", { name: "Close", exact: true }).click();

  await editor.press("ControlOrMeta+Z");
  await expect.poll(() => readFile(page, path)).toBe(author);
  await expect(trackedEdits).toHaveCount(1);
  await editor.press("ControlOrMeta+Shift+Z");
  await expect.poll(() => readFile(page, path)).toBe(expected);
  await expect(trackedEdits).toHaveCount(3);

  await editor.getByText("Short close.", { exact: true }).click();
  await editor.press("Home");
  await editor.press("Shift+End");
  await page.keyboard.insertText("Author's closing.");
  await page.getByRole("button", { name: "Resume conversation", exact: true }).click();
  await page.getByRole("button", { name: "Undo direct edits", exact: true }).click();
  await expect
    .poll(() => readFile(page, path))
    .toBe(author.replace("Closing line.\nClosing detail.", "Author's closing.\nShort detail."));
  const changed = review.getByRole("group", { name: "Proposed edit 3 of 3" });
  await expect(changed.getByText(/Author's closing\./)).toBeVisible();
  await changed.getByRole("button", { name: "Revert to selected text" }).click();
  await expect.poll(() => readFile(page, path)).toBe(author);
});

test("reverting a restored task across turns preserves later manuscript edits", async ({
  page,
  browser,
}) => {
  const title = "Revise the opening.";
  const source =
    "\uFEFFOpening draft.\r\n\r\nMargin note.  \n\nMiddle draft.\r\n\r\nKeep this.\n\nClosing draft.";
  const applied = source
    .replace("Opening draft.", "Opening revision.")
    .replace("Middle draft.", "Middle revision.")
    .replace("Closing draft.", "Closing revision.");
  const handEdited = applied.replace("Margin note.", "Author's Margin note.");
  const author = handEdited.replace("Closing revision.", "Author's closing.");
  const expected = author
    .replace("Opening revision.", "Opening draft.")
    .replace("Middle revision.", "Middle draft.");
  await page.route(endpoint, (route) => {
    const { messages } = route.request().postDataJSON();
    const { instruction } = JSON.parse(messages.at(-1).content);
    const replacement =
      instruction === title
        ? source.replace("Opening draft.", "Opening revision.")
        : source
            .replace("Middle draft.", "Middle revision.")
            .replace("Closing draft.", "Closing revision.");
    return route.fulfill({ json: replacementReply(replacement.slice(1)) });
  });
  await openManuscript(page, source, false);
  const editor = page.locator(".cm-content");
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const inline = page.getByRole("region", { name: "Ask AI" });
  const first = inline.getByRole("textbox", { name: "Instruction" });
  await first.fill(title);
  await first.press("Enter");
  await inline.getByRole("button", { name: "Apply proposed edit", exact: true }).click();
  await inline.getByRole("button", { name: "Continue in sidebar" }).click();
  const sidebar = page.getByRole("complementary", { name: "Writing Assistant" });
  const second = sidebar.getByRole("textbox", { name: "Instruction" });
  await second.fill("Revise the middle and closing, apply directly");
  await second.press("Enter");
  await expect(editor).toContainText("Closing revision.");
  await expect(sidebar.getByRole("group", { name: "Proposed edit 2 of 2" })).toContainText(
    "Applied",
  );
  await sidebar.getByRole("button", { name: "Close", exact: true }).click();
  await editor.getByText("Margin note.", { exact: true }).click();
  await editor.press("Home");
  await page.keyboard.insertText("Author's ");
  await editor.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(handEdited);
  const appData = await page.evaluate(() =>
    Object.fromEntries(
      (window as unknown as { __MINT_MEMORY_PLATFORM__: MemoryPlatform }).__MINT_MEMORY_PLATFORM__
        .appData,
    ),
  );

  const rebooted = await browser.newContext();
  try {
    const resumed = await rebooted.newPage();
    await launch(resumed, {
      locale: "en-US",
      files: { [path]: author, [settingsPath]: '{"autosave":false}' },
      openedPaths: [{ path, kind: "file" }],
      appData,
    });
    await runMenuItem(resumed, "view.openInOtherPane");
    await runMenuItem(resumed, "edit.writingTasks");
    await resumed.getByRole("button", { name: title, exact: true }).click();
    const review = resumed.getByRole("complementary", { name: "Writing Assistant" });
    const revertAll = review.getByRole("button", { name: "Revert all task edits" });
    await expect(revertAll).toBeVisible();
    await revertAll.click();
    const overlap = review.getByRole("group", { name: "Proposed edit 2 of 2" });
    await expect(overlap.getByText("Author's closing.", { exact: true })).toBeVisible();
    await expect(overlap.getByRole("button", { name: "Revert to selected text" })).toBeVisible();
    const panes = resumed.locator(".cm-content");
    await expect(panes).toHaveCount(2);
    for (const pane of await panes.all()) {
      await expect(pane).toContainText("Opening draft.");
      await expect(pane).toContainText("Middle draft.");
      await expect(pane).toContainText("Author's Margin note.");
      await expect(pane).toContainText("Author's closing.");
    }
    expect(await readFile(resumed, path)).toBe(author);
    await panes.last().press("ControlOrMeta+S");
    await expect.poll(() => readFile(resumed, path)).toBe(expected);
    await revertAll.click();
    await panes.last().press("ControlOrMeta+S");
    await expect.poll(() => readFile(resumed, path)).toBe(expected);
    const keep = overlap.getByRole("button", { name: "Keep current text" });
    await expect(keep).toBeVisible();
    await keep.click();
    await expect(overlap).toContainText("Kept the current text.");
    await expect(revertAll).toHaveCount(0);
    expect(await readFile(resumed, path)).toBe(expected);
  } finally {
    await rebooted.close();
  }
});
