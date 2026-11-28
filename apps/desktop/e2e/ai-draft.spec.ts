import { expect, test } from "@playwright/test";
import { launch, readFile, runMenuItem, savedDialogs } from "./memory-platform.ts";

test("draft from the welcome screen, keep editing after cancelling Save, then choose a path", async ({
  page,
}) => {
  const address = "https://draft.example.test/v1";
  const instruction = "Draft a short introduction for the field notes.";
  const generated = "Field notes from the ridge.";
  const path = "/notes/field-notes.md";
  await page.route(`${address}/chat/completions`, (route) =>
    route.fulfill({
      json: { choices: [{ message: { content: generated }, finish_reason: "stop" }] },
    }),
  );
  await launch(page, { locale: "en-US", directories: ["/notes"], saveDialogResults: [null, path] });
  await page.getByRole("button", { name: "Draft with AI" }).click();

  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("API address").fill(address);
  await composer.getByLabel("Model name").fill("fixture-model");
  await composer.getByLabel("Drafting instruction").fill(instruction);
  await expect(composer.getByText("Direct edit · Untitled draft")).toBeVisible();
  await expect(composer.getByText(`${address}/chat/completions`)).toBeVisible();

  const [sent] = await Promise.all([
    page.waitForRequest(`${address}/chat/completions`),
    composer.getByRole("button", { name: "Generate draft" }).click(),
  ]);
  const body = sent.postDataJSON();
  expect(body.model).toBe("fixture-model");
  expect(body.messages).toEqual([{ role: "user", content: expect.stringContaining(instruction) }]);

  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await expect(page.getByRole("tab", { name: "Untitled" })).toBeVisible();
  await expect(editor).toHaveText(generated);
  await expect(editor).toBeFocused();
  expect(await savedDialogs(page)).toEqual([]);

  await runMenuItem(page, "edit.writingTasks");
  const current = page.getByRole("dialog", { name: "Writing tasks" });
  await current.getByRole("button", { name: instruction, exact: true }).click();
  const draftResult = page.getByRole("region", { name: "Draft with AI" });
  await expect(draftResult.getByRole("textbox", { name: "AI reply" })).toHaveValue(generated);
  await expect(page.getByRole("tab", { name: "Untitled" })).toHaveCount(1);
  await draftResult.getByRole("button", { name: "Close", exact: true }).click();

  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => savedDialogs(page)).toHaveLength(1);
  await expect(editor).toHaveText(generated);
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBeUndefined();

  await page.keyboard.press("End");
  await page.keyboard.insertText(" Author's addition.");
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByRole("tab", { name: "field-notes.md" })).toBeVisible();
  expect(await readFile(page, path)).toBe("Field notes from the ridge. Author's addition.");

  await runMenuItem(page, "tab.close");
  await expect(page.getByRole("tab", { name: "field-notes.md" })).toHaveCount(0);
  await runMenuItem(page, "edit.allWritingTasks");
  const tasks = page.getByRole("dialog", { name: "All writing tasks" });
  const result = tasks.getByRole("listitem").filter({ hasText: instruction });
  await expect(result).toContainText("field-notes.md");
  await result.getByRole("button", { name: instruction, exact: true }).click();
  await expect(page.getByRole("tab", { name: "field-notes.md", selected: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "AI reply" })).toHaveValue(generated);
  await expect(editor).toHaveText("Field notes from the ridge. Author's addition.");
});

test("a blank draft can be written by hand while an approved Agent generates text", async ({
  page,
}) => {
  const executable = "/opt/agents/codex";
  const endpoint = "**/__test/external-agent";
  const instruction = "Draft two sentences about the ridge.";
  await page.route(endpoint, (route) => route.fulfill({ json: { text: "Sample reply." } }));
  await launch(page, {
    locale: "en-US",
    externalAgent: { executables: [executable], endpoint: "/__test/external-agent" },
  });
  await page.getByRole("button", { name: "Start writing" }).click();
  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await expect(editor).toBeFocused();
  await expect(page.getByRole("form", { name: "Draft with AI" })).toBeHidden();
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "External Agents" }).click();
  await settings.getByLabel("Codex executable").fill(executable);
  await settings.getByRole("button", { name: "Inspect Agent" }).click();
  await settings.getByRole("button", { name: "Try example" }).click();
  await settings.getByRole("button", { name: "Allow and send" }).click();
  await expect(settings.getByText("Sample reply.")).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Draft with AI" }).click();
  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("Writing connection").selectOption({ label: executable });
  await expect(composer.getByText("Codex read-only shell")).toBeVisible();
  await composer.getByLabel("Drafting instruction").fill(instruction);
  await page.route(endpoint, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      path: executable,
      access: "readOnly",
      request: { instruction: expect.stringContaining(instruction) },
    });
    await editor.click();
    await page.keyboard.insertText("The author started writing.");
    await route.fulfill({ json: { text: "Generated by the Agent." } });
  });
  await composer.getByRole("button", { name: "Generate draft" }).click();
  await expect(composer.getByRole("alert")).toContainText("Your edits were kept.");
  await expect(editor).toHaveText("The author started writing.");
  await expect(editor).toBeFocused();
});

test("drafting can send through a model configured in Settings", async ({ page }) => {
  const address = "https://remembered.example.test/v1";
  const endpoint = `${address}/chat/completions`;
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: { choices: [{ message: { content: "A draft from the lab." }, finish_reason: "stop" }] },
    }),
  );
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Lab model");
  await settings.getByLabel("API address").fill(address);
  await settings.getByLabel("Model name").fill("lab-fixture");
  await settings.getByLabel("API key", { exact: true }).fill("session-fixture-key");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Lab model" })).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: "Draft with AI" }).click();
  const composer = page.getByRole("form", { name: "Draft with AI" });
  await expect(composer.getByText(endpoint)).toBeVisible();
  await composer.getByLabel("Drafting instruction").fill("Draft a lab update.");
  const [sent] = await Promise.all([
    page.waitForRequest(endpoint),
    composer.getByRole("button", { name: "Generate draft" }).click(),
  ]);
  expect(sent.headers().authorization).toBe("Bearer session-fixture-key");
  expect(sent.postDataJSON().model).toBe("lab-fixture");
  await expect(
    page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true }),
  ).toHaveText("A draft from the lab.");
});

test("a draft request stays local if the author saves the empty tab first", async ({ page }) => {
  const address = "https://draft.example.test/v1";
  const path = "/notes/empty.md";
  const requests: string[] = [];
  await page.route(`${address}/chat/completions`, (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      json: { choices: [{ message: { content: "Unexpected reply." }, finish_reason: "stop" }] },
    });
  });
  await launch(page, { locale: "en-US", directories: ["/notes"], saveDialogResults: [path] });
  await page.getByRole("button", { name: "Draft with AI" }).click();

  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("API address").fill(address);
  await composer.getByLabel("Model name").fill("fixture-model");
  await composer.getByLabel("Drafting instruction").fill("Draft some field notes.");
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByRole("tab", { name: "empty.md" })).toBeVisible();

  await composer.getByRole("button", { name: "Generate draft" }).click();
  await expect(composer.getByRole("alert")).toHaveText("Start with an empty untitled draft.");
  expect(requests).toEqual([]);
  expect(await readFile(page, path)).toBe("");
});

test("closing a temporary draft keeps the saved manuscript and clears its writing task", async ({
  page,
}) => {
  const address = "https://private-draft.example.test/v1";
  const manuscript = "A private draft.";
  const instruction = "Draft from the private interview.";
  const path = "/notes/private.md";
  await page.route(`${address}/chat/completions`, (route) =>
    route.fulfill({
      json: { choices: [{ message: { content: manuscript }, finish_reason: "stop" }] },
    }),
  );
  await launch(page, { locale: "en-US", directories: ["/notes"], saveDialogResults: [path] });
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("API address").fill(address);
  await composer.getByLabel("Model name").fill("fixture");
  await composer.getByLabel("Temporary session").check({ timeout: 3000 });
  await composer.getByLabel("Drafting instruction").fill(instruction);
  await composer.getByRole("button", { name: "Generate draft" }).click();
  await expect(page.locator(".cm-content")).toHaveText(manuscript);
  await runMenuItem(page, "file.save");
  await expect.poll(() => readFile(page, path)).toBe(manuscript);
  await page.getByRole("button", { name: "Close temporary session" }).click();
  const close = page.getByRole("dialog", { name: "Close temporary session" });
  await close.getByRole("button", { name: "Close temporary session" }).click();
  await expect(close).toBeHidden();
  await runMenuItem(page, "edit.allWritingTasks");
  await expect(page.getByRole("dialog", { name: "All writing tasks" })).toBeVisible();
  await expect(page.getByRole("button", { name: instruction, exact: true })).toHaveCount(0);
  expect(await readFile(page, path)).toBe(manuscript);
});

test("retry previews and reuses the approved follow-up excerpt after a disconnect", async ({
  page,
}) => {
  const first = "https://first-draft.example.test/v1/chat/completions";
  const second = "https://second-draft.example.test/v1/chat/completions";
  const excerpt = "An approved excerpt from the interview transcript.";
  const received: unknown[] = [];
  let firstCalls = 0;
  await page.route(first, async (route) => {
    const body = route.request().postDataJSON();
    firstCalls++;
    if (firstCalls === 1) {
      await route.fulfill({
        json: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  requestMaterial: { name: "Interview", purpose: "Verify the quotation" },
                }),
              },
              finish_reason: "stop",
            },
          ],
        },
      });
    } else {
      received.push(JSON.parse(body.messages.at(-1).content));
      await route.abort();
    }
  });
  await page.route(second, (route) => {
    received.push(JSON.parse(route.request().postDataJSON().messages.at(-1).content));
    return route.fulfill({ json: { choices: [{ message: { content: "A sourced draft." } }] } });
  });
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  for (const [name, address] of [
    ["First model", first],
    ["Second model", second],
  ] as const) {
    await settings.getByLabel("Connection name").fill(name);
    await settings.getByLabel("API address").fill(address);
    await settings.getByLabel("Model name").fill("fixture");
    await settings.getByRole("button", { name: "Use for this launch" }).click();
    await expect(settings.getByRole("region", { name })).toBeVisible();
  }
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const draft = page.getByRole("form", { name: "Draft with AI" });
  await draft.getByLabel("Writing connection").selectOption({ label: "First model" });
  await draft.getByLabel("Drafting instruction").fill("Write from the interview.");
  await draft.getByRole("button", { name: "Generate draft" }).click();
  const approval = draft.getByRole("group", { name: "Additional material requested" });
  await approval.getByText("Add files or paste text").click();
  await approval.getByRole("textbox", { name: "Pasted material" }).fill(excerpt);
  await approval.getByRole("button", { name: "Add pasted text" }).click();
  await approval.getByRole("radio", { name: "Pasted text" }).check();
  await approval.getByRole("button", { name: "Allow once" }).click();
  await draft.getByLabel("Retry connection").selectOption({ label: `Second model · ${second}` });
  const retry = draft.getByRole("region", { name: "Material send plan" });
  await retry.getByText("Pasted text", { exact: true }).click();
  await expect(retry.getByText(excerpt, { exact: true })).toBeVisible();
  expect(received).toHaveLength(1);
  await draft.getByRole("button", { name: "Retry with selected connection" }).click();
  await expect(page.locator(".cm-content")).toHaveText("A sourced draft.");
  expect(received).toHaveLength(2);
  expect(received[1]).toEqual(received[0]);
});
