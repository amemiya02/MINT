import { expect, type Page, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

const path = "/notes/quick-edit.md";
const endpoint = "http://127.0.0.1:9876/v1/chat/completions";
const instruction = "缩短一半，直接改";

async function openManuscript(
  page: Page,
  source: string,
  autosave: boolean,
  primary = "ControlOrMeta",
) {
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: JSON.stringify({ autosave }) },
    openedPaths: [{ path, kind: "file" }],
  });
  await page.keyboard.press(`${primary}+,`);
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

test("Windows redo autosaves independent direct edits with mixed line endings", async ({
  page,
}) => {
  await autosaveConcurrentDirectEdit(page, "\n");
});

test("Windows redo autosaves independent direct edits in a CRLF document", async ({ page }) => {
  await autosaveConcurrentDirectEdit(page, "\r\n");
});

async function autosaveConcurrentDirectEdit(page: Page, lineBreak: "\n" | "\r\n") {
  await page.context().addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" });
  });
  const opening = `Opening line.${lineBreak}Extra opening detail.`;
  const closing = `Closing line.${lineBreak}Closing detail.`;
  const shortClosing = `Short close.${lineBreak}Short detail.`;
  const source = `\uFEFF${opening}\r\n\r\nMiddle line.${lineBreak}${lineBreak}Keep these spaces.  \r\n\r\n${closing}\r\n`;
  const author = source.replace("Middle line.", "Author's middle line.");
  const expected = author.replace(opening, "Short opening.").replace(closing, shortClosing);
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
  await openManuscript(page, source, true, "Control");
  await page.getByRole("button", { name: "Track changes", exact: true }).click();
  const trackedChanges = page.getByRole("region", { name: "Tracked changes" });
  const trackedEdits = trackedChanges.getByRole("button", { name: "Reject", exact: true });

  const editor = page.locator(".cm-content");
  await expect(editor).toBeFocused();
  await editor.press("Control+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Instruction" });
  await input.fill(instruction);
  await input.press("Enter");
  await expect.poll(() => requests).toEqual([{ instruction, selectedText: source.slice(1) }]);

  await editor.getByText("Middle line.", { exact: true }).click();
  await editor.press("Home");
  await editor.press("Shift+End");
  await page.keyboard.type("Author's middle line.");
  await expect.poll(() => readFile(page, path)).toBe(author);
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

  for (const redoShortcut of ["Control+Y", "Control+Shift+Z"]) {
    await editor.press("Control+Z");
    await expect.poll(() => readFile(page, path)).toBe(author);
    await expect(trackedEdits).toHaveCount(1);
    await editor.press(redoShortcut);
    await expect(
      editor.getByText("Short opening.", { exact: true }),
      `${redoShortcut} should restore the rewritten opening`,
    ).toBeVisible();
    await expect(editor.getByText("Short close.", { exact: true })).toBeVisible();
    await expect.poll(() => readFile(page, path)).toBe(expected);
    await expect(trackedEdits).toHaveCount(3);
  }

  await editor.getByText("Short close.", { exact: true }).click();
  await editor.press("Home");
  await editor.press("Shift+End");
  await page.keyboard.insertText("Author's closing.");
  await page.getByRole("button", { name: "Resume conversation", exact: true }).click();
  await page.getByRole("button", { name: "Undo direct edits", exact: true }).click();
  await expect
    .poll(() => readFile(page, path))
    .toBe(author.replace(closing, shortClosing.replace("Short close.", "Author's closing.")));
  const changed = review.getByRole("group", { name: "Proposed edit 3 of 3" });
  await expect(changed.getByText(/Author's closing\./)).toBeVisible();
  await changed.getByRole("button", { name: "Revert to selected text" }).click();
  await expect.poll(() => readFile(page, path)).toBe(author);

  await conflict.getByRole("button", { name: "Apply to compared text" }).click();
  await expect
    .poll(() => readFile(page, path))
    .toBe(author.replace("Author's middle line.", "Model's middle line."));
  await editor.press("Control+Z");
  await expect.poll(() => readFile(page, path)).toBe(author);
}
