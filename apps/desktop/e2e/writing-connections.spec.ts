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
  const entries = [
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
  await settings.getByRole("button", { name: "Try example" }).click();
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
  ]) {
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
