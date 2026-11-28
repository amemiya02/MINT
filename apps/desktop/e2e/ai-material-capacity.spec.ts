import { expect, type Locator, type Page, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

const address = "https://bounded.example.test/v1";
const endpoint = `${address}/chat/completions`;
const publicPassage = "# Public\nRidge is open.\n";
const privatePassage = "# Internal\nPrivate ranger contact details.\n";

async function draftWithNotes(page: Page) {
  await launch(page, { locale: "en-US" });
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const draft = page.getByRole("form", { name: "Draft with AI" });
  await draft.getByLabel("API address").fill(address);
  await draft.getByLabel("Model name").fill("bounded-fixture");
  await draft.getByLabel("Drafting instruction").fill("Write a visitor bulletin.");
  return draft;
}

async function dropNotes(draft: Locator, text: string) {
  await draft.getByRole("group", { name: "Task context to send" }).evaluate((target, text) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([text], "field-notes.md"));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, text);
}

async function askAi(page: Page, draft: string, selection: string, models: [string, string][]) {
  await launch(page, {
    locale: "en-US",
    files: { [settingsPath]: '{"autosave":false}', [draft]: selection },
    openedPaths: [{ path: draft, kind: "file" }],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  for (const [name, url] of models) {
    await settings.getByLabel("Connection name").fill(name);
    await settings.getByLabel("API address").fill(url);
    await settings.getByLabel("Model name").fill("fixture");
    await settings.getByRole("button", { name: "Use for this launch" }).click();
    await expect(settings.getByRole("region", { name })).toBeVisible();
  }
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await editor.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  return { editor, composer: page.getByRole("region", { name: "Ask AI" }) };
}

function materialEndpoint(page: Page, limit: number) {
  const received: { name: string; text: string }[][] = [];
  const ready = page.route(endpoint, async (route) => {
    const { taskContext } = JSON.parse(route.request().postDataJSON().messages.at(-1).content);
    const materials = taskContext.materials;
    received.push(materials);
    const bytes = Buffer.byteLength(materials.map(({ text }: { text: string }) => text).join(""));
    if (bytes > limit) {
      await route.fulfill({
        status: 400,
        json: { error: { code: "context_length_exceeded", message: "Fixture capacity exceeded" } },
      });
      return;
    }
    await route.fulfill({
      json: {
        choices: [
          { message: { content: `Bulletin part ${received.length}.` }, finish_reason: "stop" },
        ],
      },
    });
  });
  return { received, ready };
}

test("a capacity rejection waits for approval of exact excerpt lines at the selected endpoint", async ({
  page,
}) => {
  const { received, ready } = materialEndpoint(page, 32);
  await ready;
  const draft = await draftWithNotes(page);
  const send = draft.getByRole("button", { name: "Generate draft" });
  await dropNotes(draft, publicPassage + privatePassage);
  await send.click();
  await expect(draft.getByText(/recipient rejected the material/i)).toBeVisible();
  await expect(send).toBeDisabled();
  expect(received).toEqual([[{ name: "field-notes.md", text: publicPassage + privatePassage }]]);

  await draft.getByLabel("Material limit (UTF-8 bytes)").fill("32");
  await draft.getByLabel("Material handling").selectOption("excerpt");
  await draft.getByLabel("Last line").fill("2");
  const preview = draft.getByRole("region", { name: "Material send plan" });
  await expect(preview).toContainText(endpoint);
  await expect(preview).toContainText("Excerpt");
  await expect(preview).toContainText("field-notes.md · lines 1–2 · Public");
  await expect(preview).not.toContainText("Private ranger");
  await expect(draft.getByRole("group", { name: "Source material" })).toContainText(
    "Private ranger",
  );
  expect(received).toHaveLength(1);
  await send.click();
  await expect(
    page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true }),
  ).toHaveText("Bulletin part 2.");
  expect(received[1]).toEqual([
    { name: "field-notes.md · lines 1–2 · Public", text: publicPassage },
  ]);
});

test("a bounded endpoint receives every section in the previewed batches", async ({ page }) => {
  const first = "# Water\r\n水 is clear.\r\n";
  const second = "# Trail\r\nTrail is open.\r\n";
  const { received, ready } = materialEndpoint(page, 25);
  await ready;
  const draft = await draftWithNotes(page);
  const send = draft.getByRole("button", { name: "Generate draft" });
  await dropNotes(draft, first + second);
  await draft.getByLabel("Material limit (UTF-8 bytes)").fill("25");
  await expect(send).toBeDisabled();
  await draft.getByLabel("Material handling").selectOption("batch");
  await draft.getByRole("button", { name: "Remove field-notes.md" }).click();
  await expect(send).toBeEnabled();
  await dropNotes(draft, first + second);
  await draft.getByLabel("Material handling").selectOption("batch");
  const preview = draft.getByRole("region", { name: "Material send plan" });
  await expect(preview).toContainText(endpoint);
  await expect(preview).toContainText("Batch 1 of 2");
  await expect(preview).toContainText("field-notes.md · lines 1–2 · Water");
  await expect(preview).toContainText("Batch 2 of 2");
  await expect(preview).toContainText("field-notes.md · lines 3–4 · Trail");
  expect(received).toHaveLength(0);

  await send.click();
  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await expect(editor).toContainText("Bulletin part 1.");
  await expect(editor).toContainText("Bulletin part 2.");
  expect(received).toEqual([
    [{ name: "field-notes.md · lines 1–2 · Water", text: first }],
    [{ name: "field-notes.md · lines 3–4 · Trail", text: second }],
  ]);
});

test("Ask AI sends the approved local summary with the selection to the chosen model", async ({
  page,
}) => {
  const draft = "/trail/bulletin.md";
  const selection = "Old copy.";
  const summary = "Ridge is open.";
  const otherAddress = "https://other.example.test/v1";
  const requests: { endpoint: string; content: unknown }[] = [];
  await page.route(
    /https:\/\/(bounded|other)\.example\.test\/v1\/chat\/completions/,
    async (route) => {
      const content = JSON.parse(route.request().postDataJSON().messages.at(-1).content);
      requests.push({ endpoint: route.request().url(), content });
      const material = content.taskContext.materials[0]?.text ?? "";
      const oversized = Buffer.byteLength(content.selectedText + material) > 24;
      await route.fulfill(
        oversized
          ? { status: 413 }
          : {
              json: {
                choices: [
                  {
                    message: { content: "<replacement>The ridge is open.</replacement>" },
                    finish_reason: "stop",
                  },
                ],
              },
            },
      );
    },
  );
  const { editor, composer } = await askAi(page, draft, selection, [
    ["Other model", otherAddress],
    ["Bounded model", address],
  ]);
  const destination = composer.getByRole("combobox", { name: "Recipient" });
  await destination.selectOption({ label: `Other model · ${otherAddress}/chat/completions` });
  await composer
    .getByLabel("Instruction", { exact: true })
    .fill("Update this bulletin, apply directly");
  await dropNotes(composer, publicPassage + privatePassage);
  await composer.getByLabel("Material limit (UTF-8 bytes)").fill("24");
  await composer.getByLabel("Material handling").selectOption("summary");
  await composer.getByLabel("Summary to send").fill(summary);
  await destination.selectOption({ label: `Bounded model · ${endpoint}` });

  const preview = composer.getByRole("region", { name: "Material send plan" });
  await expect(preview).toContainText(`Summary · Bounded model · ${endpoint}`);
  await expect(preview).toContainText("field-notes.md · summary of lines 1–4 · Public · Internal");
  await expect(preview).not.toContainText("Private ranger");
  expect(requests).toHaveLength(0);
  await composer
    .getByRole("button", { name: /^Apply directly · Current selection · Bounded model/ })
    .click();
  await expect(editor).toHaveText("The ridge is open.");
  expect(await readFile(page, draft)).toBe(selection);
  expect(requests).toEqual([
    {
      endpoint,
      content: {
        instruction: "Update this bulletin, apply directly",
        selectedText: selection,
        taskContext: {
          materials: [
            { name: "field-notes.md · summary of lines 1–4 · Public · Internal", text: summary },
          ],
        },
      },
    },
  ]);
});

test("a streamed capacity error leaves a complete proposed edit available for review", async ({
  page,
}) => {
  const selection = "Old copy.";
  const instruction = "Update this bulletin, apply directly";
  const requests: unknown[] = [];
  await page.route(endpoint, async (route) => {
    requests.push(JSON.parse(route.request().postDataJSON().messages.at(-1).content));
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        { choices: [{ delta: { content: "<replacement>Ridge is open.</replacement>" } }] },
        { error: { code: "context_length_exceeded" } },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });
  const { editor, composer } = await askAi(page, "/trail/bulletin.md", selection, [
    ["Bounded model", address],
  ]);
  await composer.getByLabel("Instruction", { exact: true }).fill(instruction);
  await composer
    .getByRole("button", { name: /^Apply directly · Current selection · Bounded model/ })
    .click();

  await expect(composer.getByText(/recipient rejected the material/i)).toBeVisible();
  await expect(composer.getByLabel("Instruction", { exact: true })).toHaveValue(instruction);
  await expect(editor).toHaveText(selection);
  const apply = composer.getByRole("button", { name: "Apply proposed edit" });
  await expect(apply).toBeVisible();
  await apply.click();
  await expect(editor).toHaveText("Ridge is open.");
  expect(requests).toEqual([{ instruction, selectedText: selection }]);
});
