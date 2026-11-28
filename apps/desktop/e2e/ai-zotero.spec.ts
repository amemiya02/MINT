import { expect, test } from "@playwright/test";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

test("verify a manuscript citation using only the selected Zotero record", async ({ page }) => {
  const path = "/field-notes.md";
  const source =
    "Field notes.\n\nThe [ridge study](https://example.test/wrong) was published in 2019.";
  const corrected =
    "The [ridge study](zotero://select/library/items/RIDGE123) was published in 2024.";
  const endpoint = "https://citations.example.test/v1/chat/completions";
  const sent: unknown[] = [];
  await page.route(endpoint, (route) => {
    sent.push(JSON.parse(route.request().postDataJSON().messages.at(-1).content));
    return route.fulfill({
      json: {
        choices: [{ message: { content: `<replacement>${corrected}</replacement>` } }],
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [settingsPath]: '{"autosave":false}', [path]: source },
    openedPaths: [{ kind: "file", path }],
    zoteroItems: [
      { key: "RIDGE123", title: "Ridge study", creators: ["Ana Rivera"], date: "2024" },
      { key: "OTHER123", title: "Unrelated field notes" },
    ],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Citation model");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("citation-fixture");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Citation model" })).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();

  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Shift+Home");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const composer = page.getByRole("region", { name: "Ask AI" });
  const context = composer.getByRole("group", { name: "Task context to send" });
  await context.getByRole("button", { name: "Add from Zotero" }).click();
  await expect(context.getByText("Read the local Zotero library for this task?")).toBeVisible();
  await context.getByRole("button", { name: "Deny access" }).click();
  await expect(context.getByRole("button", { name: "Ridge study" })).toHaveCount(0);

  await context.getByRole("button", { name: "Add from Zotero" }).click();
  await context.getByRole("button", { name: "Allow once" }).click();
  await context.getByLabel("Search Zotero").fill("ridge");
  await context.getByRole("button", { name: "Search", exact: true }).click();
  await expect(context.getByRole("button", { name: "Unrelated field notes" })).toHaveCount(0);
  await context.getByRole("button", { name: "Ridge study" }).click();

  const material =
    "Title: Ridge study\nCreators: Ana Rivera\nDate: 2024\nZotero link: zotero://select/library/items/RIDGE123";
  await expect(context.getByText("Zotero (read only)", { exact: true })).toBeVisible();
  await expect(context.getByText(`Citation model · ${endpoint}`, { exact: true })).toBeVisible();
  await expect(context.getByText(material, { exact: true })).toBeVisible();
  expect(sent).toEqual([]);
  const instruction = "Verify and correct this citation, apply directly";
  await composer.getByRole("textbox", { name: "Instruction", exact: true }).fill(instruction);
  await composer
    .getByRole("button", { name: /^Apply directly · Current selection · Citation model/ })
    .click();
  await expect(editor).toContainText("was published in 2024.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(page, path)).toBe(`Field notes.\n\n${corrected}`);
  expect(sent).toEqual([
    {
      instruction,
      selectedText: source.split("\n\n")[1],
      taskContext: { materials: [{ name: "Zotero · Ridge study", text: material }] },
    },
  ]);
});

test("attach a Zotero record when adding an Agent from the manuscript", async ({ page }) => {
  const path = "/field-notes.md";
  const executable = "/opt/agents/fixture-codex";
  const sent: unknown[] = [];
  await page.route("**/__test/external-agent", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { text: "The correct year is 2024." } });
  });
  await launch(page, {
    locale: "en-US",
    files: { [path]: "Ridge study (2019)." },
    openedPaths: [{ kind: "file", path }],
    externalAgent: { executables: [executable], endpoint: "/__test/external-agent" },
    zoteroItems: [{ key: "RIDGE123", title: "Ridge study", date: "2024" }],
  });
  await page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Shift+Home");
  await runMenuItem(page, "edit.askExternalAgent");
  const dialog = page.getByRole("dialog", { name: "Ask External Agent" });
  await dialog.getByLabel("Codex executable").fill(executable);
  await dialog.getByRole("button", { name: "Inspect Agent" }).click();
  const context = dialog.getByRole("group", { name: "Task context to send" });
  await expect(context.getByRole("button", { name: "Add from Zotero" })).toBeVisible();
  await context.getByRole("button", { name: "Add from Zotero" }).click();
  await context.getByRole("button", { name: "Allow once" }).click();
  await context.getByRole("button", { name: "Ridge study" }).click();
  await expect(context.getByText(`Codex · ${executable}`, { exact: true })).toBeVisible();
  await expect(context.getByText("Zotero (read only)", { exact: true })).toBeVisible();
  const addFromZotero = context.getByRole("button", { name: "Add from Zotero" });
  await addFromZotero.click();
  await expect(context.getByText("Read the local Zotero library for this task?")).toBeVisible();
  await addFromZotero.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(addFromZotero).toHaveAttribute("aria-expanded", "false");
  await expect(context.getByText("Zotero · Ridge study", { exact: true })).toBeVisible();
  await dialog.getByLabel("Instruction").fill("Check the publication year.");
  await dialog.getByRole("button", { name: "Send selection" }).click();
  expect(sent).toEqual([]);
  await dialog.getByRole("button", { name: "Allow and send" }).click();
  await expect(dialog.getByRole("textbox", { name: "AI reply" })).toHaveValue(
    "The correct year is 2024.",
  );
  expect(sent).toEqual([
    {
      path: executable,
      access: "readOnly",
      request: {
        instruction: expect.stringContaining("Check the publication year."),
        selectedText: "Ridge study (2019).",
        taskContext: {
          materials: [
            {
              name: "Zotero · Ridge study",
              text: "Title: Ridge study\nDate: 2024\nZotero link: zotero://select/library/items/RIDGE123",
            },
          ],
        },
      },
    },
  ]);
});
