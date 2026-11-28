import { expect, type Locator, type Page, test } from "@playwright/test";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

const cloud = "https://writer.example.test/v1";
const local = "http://127.0.0.1:19896/v1";
const reviewer = "https://reviewer.example.test/v1";
const agent = "/opt/agents/writing-codex";
const defaults = "Default writing connection";
const completion = "Inline completion";
const review = "Review connection";
const multiFile = "Multi-file connection";

async function openSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  return page.getByRole("dialog", { name: "Settings" });
}

async function addModels(settings: Locator, withReviewer = false) {
  const entries: [name: string, address: string, model: string][] = [
    ["Local writer", local, "local-writer"],
    ["Cloud writer", cloud, "cloud-writer"],
  ];
  if (withReviewer) entries.push(["Manuscript reviewer", reviewer, "manuscript-reviewer"]);
  await settings.getByRole("button", { name: "Model connections" }).click();
  for (const [name, address, model] of entries) {
    await settings.getByLabel("Connection name").fill(name);
    await settings.getByLabel("API address").fill(address);
    await settings.getByLabel("Model name").fill(model);
    await settings.getByRole("button", { name: "Use for this launch" }).click();
    await expect(settings.getByRole("region", { name })).toBeVisible();
  }
  await settings.getByRole("button", { name: "Model connections" }).click();
}

test("each writing action can try its effective connection with sample text", async ({ page }) => {
  const received: string[] = [];
  for (const address of [local, cloud]) {
    await page.route(`${address}/chat/completions`, (route) => {
      received.push(route.request().postDataJSON().model);
      return route.fulfill({
        json: { choices: [{ message: { content: "Sample model response." } }] },
      });
    });
  }
  await page.route("**/__test/writing-agent", (route) => {
    const { path, access } = route.request().postDataJSON();
    received.push(`${path} · ${access}`);
    return route.fulfill({ json: { text: "Sample Agent response." } });
  });
  await launch(page, {
    locale: "en-US",
    externalAgent: { executables: [agent], endpoint: "/__test/writing-agent" },
  });
  const settings = await openSettings(page);
  await addModels(settings);
  await settings.getByRole("button", { name: "External Agents" }).click();
  await settings.getByLabel("Codex executable").fill(agent);
  await settings.getByRole("button", { name: "Inspect Agent" }).click();
  await settings.getByRole("button", { name: "Run sample", exact: true }).click();
  await settings.getByRole("button", { name: "Allow and send" }).click();
  await expect(settings.getByText("Sample Agent response.", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "External Agents" }).click();

  await settings.getByLabel(defaults, { exact: true }).selectOption({ label: "Cloud writer" });
  await settings.getByLabel(completion, { exact: true }).selectOption({ label: "Local writer" });
  await settings.getByLabel(multiFile, { exact: true }).selectOption({ label: agent });

  for (const [action, recipient, reply] of [
    [defaults, cloud, "Sample model response."],
    [completion, local, "Sample model response."],
    [review, cloud, "Sample model response."],
    [multiFile, agent, "Sample Agent response."],
  ] as const) {
    const setting = settings.getByRole("group", { name: action, exact: true });
    await expect(setting.locator("p").filter({ hasText: recipient })).toBeVisible();
    await setting.getByRole("button", { name: "Run sample" }).click();
    await expect(setting.getByText(reply, { exact: true })).toBeVisible();
  }
  expect(received).toEqual([
    `${agent} · readOnly`,
    "cloud-writer",
    "local-writer",
    "cloud-writer",
    `${agent} · readOnly`,
  ]);
});

test("the default, review and multi-file connections reach their normal writing commands", async ({
  page,
}) => {
  const draft = "/notes/draft.md";
  const text = "Live manuscript.";
  const received: { model: string; input: unknown }[] = [];
  for (const address of [local, cloud, reviewer]) {
    await page.route(`${address}/chat/completions`, (route) => {
      const body = route.request().postDataJSON();
      const message = body.messages.at(-1).content;
      received.push({
        model: body.model,
        input: body.model === "cloud-writer" ? message : JSON.parse(message),
      });
      const content =
        body.model === "manuscript-reviewer"
          ? '{"findings":[{"quote":"Live manuscript.","note":"Add supporting evidence."}]}'
          : "Writing result.";
      return route.fulfill({ json: { choices: [{ message: { content } }] } });
    });
  }
  await launch(page, {
    locale: "en-US",
    files: { [draft]: text, "/notes/source.md": "Source text." },
    openedPaths: [{ path: draft, kind: "file" }],
    openFolderDialogResults: ["/notes"],
  });
  const settings = await openSettings(page);
  await addModels(settings, true);
  await settings.getByLabel(defaults).selectOption({ label: "Cloud writer" });
  await settings.getByLabel(review).selectOption({ label: "Manuscript reviewer" });
  await settings.getByLabel(multiFile).selectOption({ label: "Local writer" });
  await expect
    .poll(async () => Object.keys(JSON.parse((await readFile(page, settingsPath)) ?? "{}")))
    .toEqual(
      expect.arrayContaining([
        "defaultWritingConnection",
        "reviewWritingConnection",
        "multiFileWritingConnection",
      ]),
    );
  await settings.getByRole("button", { name: "Close", exact: true }).click();

  await runMenuItem(page, "edit.reviewDocument");
  const annotations = page.getByRole("complementary", { name: "Annotations" });
  await annotations
    .getByRole("button", { name: /Comment only · Current document · Manuscript reviewer/ })
    .click();
  await expect(annotations.getByText("Add supporting evidence.")).toBeVisible();
  await annotations.getByRole("button", { name: "Close", exact: true }).click();

  await runMenuItem(page, "file.openFolder");
  await expect(page.getByText("source.md", { exact: true })).toBeVisible();
  await runMenuItem(page, "edit.askFolderAI");
  const assistant = page.getByRole("complementary", { name: "Writing Assistant" });
  await assistant.getByLabel("Allow searching the current working folder").check();
  await assistant.getByRole("textbox", { name: "Instruction" }).fill("Review the working folder.");
  await assistant.getByRole("button", { name: /Working folder · Local writer/ }).click();
  await expect(assistant.getByRole("textbox", { name: "AI reply", exact: true })).toHaveValue(
    "Writing result.",
  );

  await runMenuItem(page, "file.draftWithAi");
  const composer = page.getByRole("form", { name: "Draft with AI" });
  const instruction = composer.getByRole("textbox", { name: "Drafting instruction" });
  await instruction.fill("Write an opening line.");
  await expect(composer.getByRole("group", { name: "Task context to send" })).toContainText(
    "Cloud writer",
  );
  await expect(composer.getByRole("button", { name: "Generate draft" })).toBeEnabled();
  await instruction.press("Enter");
  await expect(page.getByRole("tabpanel").locator(".cm-content")).toHaveText("Writing result.");
  expect(received).toEqual([
    { model: "manuscript-reviewer", input: expect.objectContaining({ selectedText: text }) },
    {
      model: "local-writer",
      input: { instruction: "Review the working folder.", taskContext: { folderSearch: true } },
    },
    { model: "cloud-writer", input: expect.stringContaining("Write an opening line.") },
  ]);
});

test("an offline local edit keeps the instruction and asks before retrying in the cloud", async ({
  page,
}) => {
  const draft = "/notes/draft.md";
  const original = "A long opening sentence.";
  const typed = "Shorten this, apply directly";
  const received: unknown[] = [];
  let localRequests = 0;
  await page.route(`${local}/chat/completions`, (route) => {
    localRequests++;
    return route.abort("connectionrefused");
  });
  const endpoint = `${cloud}/chat/completions`;
  await page.route(endpoint, (route) => {
    const body = route.request().postDataJSON();
    received.push(JSON.parse(body.messages.at(-1).content));
    return route.fulfill({
      json: { choices: [{ message: { content: "<replacement>Short opening.</replacement>" } }] },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [draft]: original },
    openedPaths: [{ path: draft, kind: "file" }],
  });
  const settings = await openSettings(page);
  await addModels(settings);
  await settings.getByLabel(defaults).selectOption({ label: "Local writer" });
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await editor.press("ControlOrMeta+A");
  await runMenuItem(page, "edit.askAI");
  const assistant = page.getByRole("region", { name: "Ask AI", exact: true });
  const instruction = assistant.getByRole("textbox", { name: "Instruction" });
  await instruction.fill(typed);
  await assistant
    .getByRole("button", { name: /Apply directly · Current selection · Local writer/ })
    .click();
  await expect(assistant.getByRole("alert")).toContainText("Local model is unreachable");
  await expect(instruction).toHaveValue(typed);
  await expect(editor).toHaveText(original);
  expect(localRequests).toBe(1);
  expect(received).toEqual([]);

  await assistant
    .getByLabel("Retry connection")
    .selectOption({ label: `Cloud writer · ${endpoint}` });
  await expect(assistant.locator("p").filter({ hasText: endpoint }).first()).toBeVisible();
  expect(received).toEqual([]);
  await assistant.getByRole("button", { name: "Retry with selected connection" }).click();
  await expect(editor).toHaveText("Short opening.");
  expect(received).toEqual([{ instruction: typed, selectedText: original }]);
});

test("inline completion retries the same excerpt once with an explicitly chosen cloud model", async ({
  page,
}) => {
  const draft = "/notes/draft.md";
  const receivedLocal: unknown[] = [];
  const receivedCloud: unknown[] = [];
  await page.route(`${local}/chat/completions`, (route) => {
    receivedLocal.push(JSON.parse(route.request().postDataJSON().messages.at(-1).content));
    return route.abort("connectionrefused");
  });
  const endpoint = `${cloud}/chat/completions`;
  await page.route(endpoint, (route) => {
    receivedCloud.push(JSON.parse(route.request().postDataJSON().messages.at(-1).content));
    return route.fulfill({
      json: { choices: [{ message: { content: " follows the ridge." }, finish_reason: "stop" }] },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [draft]: "The" },
    openedPaths: [{ path: draft, kind: "file" }],
  });
  const settings = await openSettings(page);
  await addModels(settings);
  await settings.getByLabel(defaults).selectOption({ label: "Local writer" });
  await settings
    .getByLabel(completion)
    .selectOption({ label: "Use the default writing connection" });
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await editor.press("End");
  await page.keyboard.type(" trail");

  const recovery = page.getByRole("region", { name: "Inline completion" });
  await expect(recovery.getByRole("status")).toContainText("Local model is unreachable");
  await expect(editor).toHaveText("The trail");
  expect(receivedLocal).toEqual([{ before: "The trail", after: "" }]);
  expect(receivedCloud).toEqual([]);
  await recovery
    .getByLabel("Retry connection")
    .selectOption({ label: `Cloud writer · ${endpoint}` });
  await expect(recovery.locator("p").filter({ hasText: endpoint })).toBeVisible();
  expect(receivedCloud).toEqual([]);
  await recovery.getByRole("button", { name: "Retry with selected connection" }).click();
  await expect(editor.getByText("follows the ridge.", { exact: true })).toBeVisible();
  expect(receivedCloud).toEqual(receivedLocal);
  await editor.press("Tab");
  await expect(editor).toHaveText("The trail follows the ridge.");

  await page.keyboard.type(" Today");
  await expect(recovery.getByRole("status")).toContainText("Local model is unreachable");
  expect(receivedLocal).toHaveLength(2);
  expect(receivedCloud).toHaveLength(1);
});

test("alternate retry previews the earlier conversation that it sends", async ({ page }) => {
  const draft = "/notes/conversation.md";
  const question = "What is the theme of the opening?";
  const answer = "The opening introduces the ridge.";
  const followUp = "Where should the next paragraph go?";
  let localRequests = 0;
  const cloudRequests: { messages: { role: string; content: string }[] }[] = [];
  await page.route(`${local}/chat/completions`, (route) => {
    localRequests++;
    return localRequests === 1
      ? route.fulfill({ json: { choices: [{ message: { content: answer } }] } })
      : route.abort("connectionrefused");
  });
  const endpoint = `${cloud}/chat/completions`;
  await page.route(endpoint, (route) => {
    cloudRequests.push(route.request().postDataJSON());
    return route.fulfill({
      json: { choices: [{ message: { content: "Continue with the trail." } }] },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [draft]: "Notes from the ridge." },
    openedPaths: [{ path: draft, kind: "file" }],
  });
  const settings = await openSettings(page);
  await addModels(settings);
  await settings.getByLabel(defaults).selectOption({ label: "Local writer" });
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await runMenuItem(page, "edit.askAI");
  const inline = page.getByRole("region", { name: "Ask AI", exact: true });
  await inline.getByRole("textbox", { name: "Instruction" }).fill(question);
  await inline.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect(inline.getByRole("textbox", { name: "AI reply" })).toHaveValue(answer);
  await inline.getByRole("button", { name: "Continue in sidebar" }).click();
  const assistant = page.getByRole("complementary", { name: "Writing Assistant" });
  const instruction = assistant.getByRole("textbox", { name: "Instruction", exact: true });
  await instruction.fill(followUp);
  await instruction.press("Enter");
  await assistant
    .getByLabel("Retry connection")
    .selectOption({ label: `Cloud writer · ${endpoint}` });
  const earlier = assistant.getByText("Earlier messages to send", { exact: true });
  await earlier.click({ timeout: 3000 });
  const payload = assistant.locator("details").filter({
    has: page.getByText("Earlier messages to send", { exact: true }),
  });
  await expect(payload.getByText(question, { exact: true })).toBeVisible();
  await expect(payload.getByText(answer, { exact: true })).toBeVisible();
  expect(cloudRequests).toHaveLength(0);
  await assistant.getByRole("button", { name: "Retry with selected connection" }).click();
  await expect.poll(() => cloudRequests.length).toBe(1);
  expect(cloudRequests[0]?.messages).toEqual(
    expect.arrayContaining([
      { role: "user", content: question },
      { role: "assistant", content: answer },
    ]),
  );
});

test("a model address with a query credential cannot be saved or sampled", async ({ page }) => {
  await launch(page, { locale: "en-US" });
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Query key fixture");
  await settings.getByLabel("Model name").fill("fixture");
  await settings.getByLabel("API address").fill(`${cloud}?api-key=private-fixture-key`);
  await expect(settings.getByRole("button", { name: "Use for this launch" })).toBeDisabled();
  await expect(settings.getByRole("button", { name: "Run sample", exact: true })).toBeDisabled();
  await expect(settings.getByRole("region", { name: "Query key fixture" })).toHaveCount(0);
  await settings.getByLabel("API address").fill(cloud);
  await expect(settings.getByRole("button", { name: "Use for this launch" })).toBeEnabled();
});
