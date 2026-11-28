import { expect, type Page, test } from "@playwright/test";
import { externalWrite, launch, readFile, settingsPath } from "./memory-platform.ts";

const path = "/notes/review.md";
const endpoint = "https://review.example.test/v1/chat/completions";

async function openReview(page: Page, source: string) {
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
  });
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
  await expect(editor).toBeFocused();
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  return { editor, review: page.getByRole("region", { name: "Ask AI" }) };
}

test("a model replacement can be reviewed and applied one change at a time", async ({ page }) => {
  const source =
    "\uFEFF**Original opening.**\r\n\r\nKeep this paragraph.  \n\nOriginal ending.\r\n";
  const replacement = "**Revised opening.**\n\nKeep this paragraph.  \n\nRevised ending.\n";
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: {
        choices: [
          {
            message: { content: `<replacement>${replacement}</replacement>` },
            finish_reason: "stop",
          },
        ],
      },
    }),
  );
  const { editor, review } = await openReview(page, source);
  const instruction = review.getByRole("textbox", { name: "Instruction" });
  await instruction.fill("Revise the opening and the ending.");
  await instruction.press("Enter");

  const opening = review.getByRole("group", { name: "Proposed edit 1 of 2" });
  const ending = review.getByRole("group", { name: "Proposed edit 2 of 2" });
  await expect(opening.getByRole("strong").filter({ hasText: "Revised opening." })).toBeVisible();
  expect(await readFile(page, path)).toBe(source);
  await expect(editor).toContainText("Original opening.");
  await review.getByLabel("Show Markdown source").check();
  await expect(opening.getByText("**Revised opening.**", { exact: true })).toBeVisible();
  await opening.getByRole("button", { name: "Apply proposed edit" }).click();
  await ending.getByRole("button", { name: "Dismiss proposed edit" }).click();

  await expect(editor).toContainText("Revised opening.");
  await expect(editor).toContainText("Original ending.");
  await editor.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe(source.replace("Original opening", "Revised opening"));
  await editor.press("ControlOrMeta+Z");
  await editor.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source);
});

test("a pending replacement compares with disk changes and later author edits", async ({
  page,
}) => {
  const source = "Original opening.\r\n\r\nKeep this paragraph.\n\nOriginal ending.\r\n";
  const disk = source.replace("Original ending", "Externally revised ending");
  const { editor, review } = await openReview(page, source);
  await page.route(endpoint, async (route) => {
    await externalWrite(page, path, disk);
    await expect(editor).toContainText("Externally revised ending.");
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content:
                "<replacement>Proposed opening.\n\nKeep this paragraph.\n\nProposed ending.\n</replacement>",
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  const instruction = review.getByRole("textbox", { name: "Instruction" });
  await instruction.fill("Revise the opening and ending.");
  await instruction.press("Enter");

  const opening = review.getByRole("group", { name: "Proposed edit 1 of 2" });
  const ending = review.getByRole("group", { name: "Proposed edit 2 of 2" });
  await expect(ending.getByText("Externally revised ending.", { exact: true })).toBeVisible();
  await expect(
    ending.getByRole("button", { name: "Apply proposed edit", exact: true }),
  ).toHaveCount(0);
  expect(await readFile(page, path)).toBe(disk);

  await editor.press("ControlOrMeta+Home");
  await editor.press("Shift+End");
  await page.keyboard.insertText("Author revised opening.");
  await expect(opening.getByText("Author revised opening.", { exact: true })).toBeVisible();
  await opening.getByRole("button", { name: "Apply to compared text" }).click();
  await expect(editor).toContainText("Proposed opening.");
  await expect(editor).toContainText("Externally revised ending.");
  await editor.press("ControlOrMeta+Z");
  await editor.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe(disk.replace("Original opening", "Author revised opening"));
});

test("requesting a rewrite sends only that change and keeps explanations in the conversation", async ({
  page,
}) => {
  const source = "Old opening.\n\nKeep this.\n\nOld ending.";
  const sent: unknown[] = [];
  await page.route(endpoint, (route) => {
    sent.push(route.request().postDataJSON().messages);
    const text = [
      "<replacement>New opening.\n\nKeep this.\n\nNew ending.</replacement>",
      "The ending needs a specific result first.",
      "<replacement>The team confirmed the result.</replacement>",
    ][sent.length - 1];
    return route.fulfill({
      json: { choices: [{ message: { content: text }, finish_reason: "stop" }] },
    });
  });
  const { editor, review } = await openReview(page, source);
  const instruction = review.getByRole("textbox", { name: "Instruction" });
  await instruction.fill("Revise the opening and ending.");
  await instruction.press("Enter");

  const opening = review.getByRole("group", { name: "Proposed edit 1 of 2" });
  const ending = review.getByRole("group", { name: "Proposed edit 2 of 2" });
  await ending.getByRole("button", { name: "Rewrite this edit" }).click();
  await ending.getByRole("textbox", { name: "Rewrite instruction" }).fill("Be more specific.");
  await ending.getByRole("button", { name: "Send rewrite" }).click();
  await expect(review.getByText("The ending needs a specific result first.")).toBeVisible();
  await expect(ending.getByText("New ending.", { exact: true })).toBeVisible();
  await expect(editor).toContainText("Old ending.");
  expect(await readFile(page, path)).toBe(source);

  await ending.getByRole("button", { name: "Rewrite this edit" }).click();
  await ending
    .getByRole("textbox", { name: "Rewrite instruction" })
    .fill("Say the team confirmed the result.");
  await ending.getByRole("button", { name: "Send rewrite" }).click();
  await expect(ending.getByText("The team confirmed the result.")).toBeVisible();
  await expect(opening.getByText("New opening.", { exact: true })).toBeVisible();
  expect(sent[1]).toEqual([
    { role: "system", content: expect.stringContaining("<replacement>") },
    { role: "user", content: "Revise the opening and ending." },
    { role: "assistant", content: "New ending." },
    { role: "user", content: '{"instruction":"Be more specific.","selectedText":"Old ending."}' },
  ]);
  await ending.getByRole("button", { name: "Apply proposed edit" }).click();
  await expect(editor).toContainText("The team confirmed the result.");
  await editor.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe("Old opening.\n\nKeep this.\n\nThe team confirmed the result.");
});

test("an explicit empty replacement can be reviewed as a deletion and undone", async ({ page }) => {
  const source = "\uFEFFObsolete line.\r\n";
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: {
        choices: [{ message: { content: "<replacement></replacement>" }, finish_reason: "stop" }],
      },
    }),
  );
  const { editor, review } = await openReview(page, source);
  const instruction = review.getByRole("textbox", { name: "Instruction" });
  await instruction.fill("Delete the selected text.");
  await instruction.press("Enter");
  const deletion = review.getByRole("group", { name: "Proposed edit 1 of 1" });
  await expect(deletion.getByText("No text", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(source);
  await deletion.getByRole("button", { name: "Apply proposed edit" }).click();
  await expect(editor).toHaveText("");
  await editor.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe("\uFEFF");
  await editor.press("ControlOrMeta+Z");
  await editor.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source);
});
