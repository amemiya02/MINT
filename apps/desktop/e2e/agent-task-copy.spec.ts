import { expect, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

test("an Agent can preview and directly edit a task copy of the unsaved manuscript", async ({
  page,
}) => {
  const executable = "/fixtures/codex";
  const path = "/notes/draft.md";
  const source = "Opening stays.  \r\n\r\nOriginal sentence.\r\n";
  const unsaved = source.replace("Original sentence.", "Original sentence. Handwritten note.");
  const proposed = unsaved.replace("Original sentence.", "Short sentence.");
  const received: unknown[] = [];
  await page.route("**/__test/task-copy", async (route) => {
    received.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        text: "Revised the copy.",
        taskCopy: received.length === 1 ? "We are reviewing the draft." : proposed,
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
    externalAgent: { executables: [executable], endpoint: "/__test/task-copy" },
  });

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "External Agents" }).click();
  await settings.getByRole("button", { name: "Discover Codex" }).click();
  await settings.getByRole("button", { name: executable, exact: true }).click();
  await settings.getByLabel("Agent permissions").selectOption("taskCopy", { timeout: 4000 });
  await settings.getByRole("button", { name: "Try example" }).click();
  expect(received).toHaveLength(0);
  await settings.getByRole("button", { name: "Allow and send" }).click();
  await expect(settings.getByText("Task copy editing verified", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();

  const editor = page.locator(".cm-content");
  await editor.getByText("Original sentence.", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Handwritten note.");

  async function send(action: "Preview first" | "Apply directly") {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.getByRole("combobox").fill("Ask AI");
    await page.keyboard.press("Enter");
    const composer = page.getByRole("region", { name: "Ask AI" });
    await composer.getByLabel("Scope").selectOption("document");
    await composer.getByLabel("Action").selectOption({ label: action });
    await composer
      .getByRole("textbox", { name: "Instruction" })
      .fill("Shorten the original sentence.");
    await composer.getByRole("textbox", { name: "Instruction" }).press("Enter");
    return composer;
  }

  const preview = await send("Preview first");
  await expect(preview.getByRole("button", { name: "Apply proposed edit" })).toBeVisible();
  await expect(editor).toContainText("Original sentence. Handwritten note.");
  expect(await readFile(page, path)).toBe(source);
  await preview.getByRole("button", { name: "Close" }).click();

  await send("Apply directly");
  await expect(editor).toContainText("Short sentence. Handwritten note.");
  expect(await readFile(page, path)).toBe(source);
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(proposed);
  expect(received.slice(1)).toEqual(
    [1, 2].map(() => ({
      path: executable,
      access: "taskCopy",
      request: {
        instruction: expect.stringContaining("Shorten the original sentence."),
        taskCopy: "edit",
        taskContext: { currentDraft: { name: "draft.md", text: unsaved } },
      },
    })),
  );
});
