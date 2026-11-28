import { expect, test } from "@playwright/test";
import { forgetExternalAgent, launch } from "./memory-platform.ts";

test("settings tries a discovered Agent only after the author allows its access", async ({
  page,
}) => {
  const received: unknown[] = [];
  await page.route("**/__test/external-agent", async (route) => {
    received.push(route.request().postDataJSON());
    await route.fulfill({ json: { text: "The sample reads clearly." } });
  });
  await launch(page, {
    locale: "en-US",
    externalAgent: { executables: ["/usr/local/bin/codex"], endpoint: "/__test/external-agent" },
  });

  await page.keyboard.press("ControlOrMeta+,");
  const agents = page.getByRole("button", { name: "External Agents", exact: true });
  await agents.click();
  await page.getByRole("button", { name: "Discover Codex" }).click();
  await page.getByRole("button", { name: "/usr/local/bin/codex", exact: true }).click();
  await page.getByRole("button", { name: "Try example" }).click();
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Agent access declined.")).toBeVisible();
  expect(received).toEqual([]);

  await page.getByRole("button", { name: "Try example" }).click();
  await page.getByRole("button", { name: "Allow and send" }).click();
  await expect(page.getByText("The sample reads clearly.")).toBeVisible();
  await agents.click();
  await expect(page.getByText("The sample reads clearly.")).toBeHidden();
  await agents.click();
  await expect(page.getByText("The sample reads clearly.")).toBeVisible();
  await expect(page.getByText("Conversation verified")).toBeVisible();
  await expect(
    page.getByText("Live streaming and multi-file tasks are unavailable.", { exact: false }),
  ).toBeVisible();
  expect(received).toEqual([
    {
      path: "/usr/local/bin/codex",
      access: "readOnly",
      request: {
        instruction: "Suggest one concise rewrite of the selected text.",
        selectedText: "We are currently in the process of reviewing the draft.",
      },
    },
  ]);
});

test("Settings asks again for the same Agent permissions when approval is gone", async ({
  page,
}) => {
  const path = "/opt/agents/fixture-codex";
  const received: unknown[] = [];
  await page.route("**/__test/external-agent", (route) => {
    received.push(route.request().postDataJSON());
    return route.fulfill({ json: { text: "Fixture reply." } });
  });
  await launch(page, {
    locale: "en-US",
    externalAgent: { executables: [path], endpoint: "/__test/external-agent" },
  });

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "External Agents", exact: true }).click();
  await settings.getByLabel("Codex executable").fill(path);
  await settings.getByRole("button", { name: "Inspect Agent" }).click();
  const permissions = settings.getByLabel("Agent permissions");
  await permissions.selectOption("configured");
  const tryExample = settings.getByRole("button", { name: "Try example" });
  await tryExample.click();
  await settings.getByRole("button", { name: "Allow and send" }).click();
  await expect(settings.getByText("Fixture reply.")).toBeVisible();
  expect(received).toEqual([expect.objectContaining({ path, access: "configured" })]);

  await forgetExternalAgent(page, path);
  await tryExample.click();
  await expect(
    settings.getByText("Agent access changed. Review its permissions before sending."),
  ).toBeVisible();
  await expect(permissions).toHaveValue("configured");
  await tryExample.click();
  await expect(
    settings.getByText("Use Codex’s configured permissions and send the task shown above.", {
      exact: false,
    }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Decline" }).click();
  await expect(settings.getByText("Agent access declined.")).toBeVisible();
  expect(received).toHaveLength(1);
});

test("a manually added Agent receives only the selected unsaved text after consent", async ({
  page,
}) => {
  const received: unknown[] = [];
  const path = "/opt/agents/my-codex";
  await page.route("**/__test/external-agent", async (route) => {
    received.push(route.request().postDataJSON());
    await route.fulfill({ json: { text: "Use a shorter phrase." } });
  });
  await launch(page, {
    locale: "en-US",
    files: { "/notes/draft.md": "Private paragraph.\n\nOriginal line." },
    openedPaths: [{ path: "/notes/draft.md", kind: "file" }],
    externalAgent: { executables: [path], endpoint: "/__test/external-agent" },
  });
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("Original line.");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(" Unsaved phrase.");
  for (let i = 0; i < "Unsaved phrase.".length; i++) await page.keyboard.press("Shift+ArrowLeft");

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox").fill("Ask External Agent");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Ask External Agent" });
  await dialog.getByLabel("Codex executable").fill(path);
  await dialog.getByRole("button", { name: "Inspect Agent" }).click();
  await expect(dialog.getByText("Unsaved phrase.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Private paragraph.")).toHaveCount(0);
  await dialog.getByLabel("Instruction").fill("Can you shorten this?");
  await dialog.getByRole("button", { name: "Send selection" }).click();
  await dialog.getByRole("button", { name: "Allow and send" }).click();
  await expect(dialog.getByText("Use a shorter phrase.")).toBeVisible();

  await dialog.getByLabel("Agent permissions").selectOption("configured");
  await expect(
    dialog.getByText("Configured file access may include writes across your account.", {
      exact: false,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Send selection" }).click();
  await expect(dialog.getByText("Change this Agent’s approved permissions?")).toBeVisible();
  await dialog.getByRole("button", { name: "Decline" }).click();
  await expect(dialog.getByText("Agent access declined.")).toBeVisible();
  expect(received).toEqual([
    {
      path,
      access: "readOnly",
      request: { instruction: "Can you shorten this?", selectedText: "Unsaved phrase." },
    },
  ]);
  await expect(editor).toContainText("Original line. Unsaved phrase.");
  await expect(editor).toContainText("Private paragraph.");

  await dialog.getByLabel("Agent permissions").selectOption("readOnly");
  await dialog.getByRole("button", { name: "Send selection" }).click();
  const reply = dialog.getByRole("textbox", { name: "AI reply" });
  await expect(reply).toHaveValue("Use a shorter phrase.");
  await reply.evaluate((field: HTMLTextAreaElement) => {
    field.focus();
    field.setSelectionRange("Use a ".length, "Use a shorter".length);
  });
  await dialog.getByRole("button", { name: "Replace original selection in draft.md" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect(editor).toContainText("Original line. shorter");
  await expect(editor).toContainText("Private paragraph.");
});
