import { expect, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

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

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "External Agents" }).click();
  await settings.getByRole("button", { name: "Discover Codex" }).click();
  await settings.getByRole("button", { name: executable, exact: true }).click();
  await settings.getByRole("button", { name: "Try example" }).click();
  await settings.getByRole("button", { name: "Allow and send" }).click();
  await expect(settings.getByText("Sample reply.")).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();

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
  await sidebar.getByRole("button", { name: "Send", exact: true }).click();
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
