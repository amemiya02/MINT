import { expect, type Page, test } from "@playwright/test";
import { launch, pickFile, readFile, runMenuItem } from "./memory-platform.ts";

async function connect(page: Page, name: string, endpoint: string) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill(name);
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name })).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
}

test("trial and share a successful writing skill using each author’s chosen materials and authorization", async ({
  page,
  browser,
}) => {
  const draft = "/book/chapter.md";
  const source = "The team are ready.";
  const oldMaterial = "Private notes from the original task.";
  const trialMaterial = "Current reference: the team is one unit.";
  const revised = "The team is ready.";
  const steps = "Identify agreement errors. Explain each correction.";
  const endpoint = "https://skills.example.test/v1/chat/completions";
  const exportPath = "/share/agreement.mint-skill.json";
  const oldTool = "https://author-tools.example.test/mcp";
  const toolCalls: unknown[] = [];
  await page.route(oldTool, async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    if (method === "notifications/initialized") return route.fulfill({ status: 202 });
    if (method === "tools/call") toolCalls.push(params);
    const result =
      method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
        : method === "tools/list"
          ? { tools: [{ name: "check_agreement", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "Private result from author's library." }] };
    return route.fulfill({ json: { jsonrpc: "2.0", id, result } });
  });
  const requests: { instruction: string; selectedText: string; taskContext?: unknown }[] = [];
  await page.route(endpoint, (route) => {
    const { messages } = route.request().postDataJSON();
    requests.push(JSON.parse(messages.at(-1).content));
    return route.fulfill({
      json: {
        choices: [
          {
            message: {
              content:
                requests.length === 1
                  ? '{"requestTool":{"name":"check_agreement","arguments":{"entry":"author-entry"}}}'
                  : requests.length === 2
                    ? "Check verb agreement."
                    : `<replacement>${revised}</replacement>`,
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { [draft]: source },
    openedPaths: [{ path: draft, kind: "file" }],
    saveDialogResults: [exportPath],
    directories: ["/share"],
  });
  await connect(page, "Author fixture", endpoint);

  const editor = page.locator(".cm-content:visible");
  const composer = page.getByRole("region", { name: "Ask AI" });
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await composer.getByRole("textbox", { name: "Instruction" }).fill(steps);
  async function addMaterial(text: string) {
    const paste = composer.getByLabel("Pasted material");
    if (!(await paste.isVisible())) await composer.getByText("Add files or paste text").click();
    await paste.fill(text);
    await composer.getByRole("button", { name: "Add pasted text" }).click();
  }
  await addMaterial(oldMaterial);
  await composer.getByText("MCP tools", { exact: true }).click();
  await composer.getByLabel("MCP endpoint").fill(oldTool);
  await composer.getByRole("button", { name: "Find tools" }).click();
  await composer
    .getByRole("combobox", { name: "MCP tool", exact: true })
    .selectOption("check_agreement");
  await composer.getByRole("combobox", { name: "External effect" }).selectOption("read");
  await composer.getByLabel("Exact arguments to authorize").fill('{"entry":"author-entry"}');
  await composer.getByLabel("Action").selectOption("comment");
  await composer.getByRole("button", { name: /Comment only · Current selection/ }).click();
  await expect(composer.getByRole("textbox", { name: "AI reply", exact: true })).toHaveValue(
    "Check verb agreement.",
  );
  await composer.getByRole("button", { name: "Save as writing skill" }).click();
  await composer.getByLabel("Skill name").fill("Agreement");
  await expect(composer.getByLabel("Writing steps")).toHaveValue(steps);
  await composer.getByLabel("Result format").fill("List each error and its correction.");
  await expect(composer.getByRole("button", { name: /Trial run/ })).toBeVisible();
  await editor.press("ControlOrMeta+A");
  await addMaterial(trialMaterial);
  await composer.getByRole("combobox", { name: "Scope", exact: true }).selectOption("selection");
  await composer.getByLabel("Action").selectOption("direct");
  await composer
    .getByRole("button", { name: /Trial run · Apply directly · Current selection/ })
    .click();
  await expect(composer.getByRole("group", { name: "Trial result" })).toContainText(revised);
  await expect(editor).toHaveText(source);
  expect(requests[2]).toMatchObject({
    selectedText: source,
    taskContext: { materials: [{ name: "Pasted text", text: trialMaterial }] },
  });
  expect(requests[2]?.instruction).toContain("List each error and its correction.");
  expect(JSON.stringify(requests[2])).not.toContain(oldMaterial);
  await composer.getByRole("button", { name: "Save skill", exact: true }).click();
  await composer.getByRole("button", { name: "Close", exact: true }).click();

  await editor.press("ControlOrMeta+A");
  await runMenuItem(page, "edit.writingSkills");
  await composer.getByRole("button", { name: "/agreement · Agreement" }).click();
  const plan = composer.getByRole("group", { name: "Writing skill plan" });
  await expect(plan).toContainText(steps);
  await expect(plan).toContainText("List each error and its correction.");
  await expect(plan).toContainText("Current selection");
  await expect(composer.getByLabel("Action")).toHaveValue("comment");
  await expect(editor).toHaveText(source);
  expect(requests).toHaveLength(3);
  await expect(plan).toContainText("check_agreement");
  await plan.getByRole("button", { name: "Export skill" }).click();
  await expect.poll(() => readFile(page, exportPath)).toBeDefined();
  const exported = (await readFile(page, exportPath)) ?? "";
  for (const privateValue of [
    source,
    oldMaterial,
    trialMaterial,
    endpoint,
    oldTool,
    "author-entry",
    "Private result",
  ]) {
    expect(exported).not.toContain(privateValue);
  }

  const receiver = await browser.newPage();
  try {
    const recipientDraft = "/writing/report.md";
    const recipientText = "The council are meeting.";
    const ownMaterial = "The council acts as a single body.";
    const ownEndpoint = "https://recipient.example.test/v1/chat/completions";
    const received: { instruction: string; selectedText: string; taskContext?: unknown }[] = [];
    const ownTool = "https://recipient-tools.example.test/mcp";
    const ownCalls: unknown[] = [];
    await receiver.route(ownTool, async (route) => {
      const { id, method, params } = route.request().postDataJSON();
      if (method === "notifications/initialized") return route.fulfill({ status: 202 });
      if (method === "tools/call") ownCalls.push(params);
      const result =
        method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
          : method === "tools/list"
            ? { tools: [{ name: "check_agreement", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "The recipient approved this reference." }] };
      return route.fulfill({ json: { jsonrpc: "2.0", id, result } });
    });
    await receiver.route(ownEndpoint, (route) => {
      received.push(JSON.parse(route.request().postDataJSON().messages.at(-1).content));
      const content =
        received.length === 1
          ? '{"requestTool":{"name":"check_agreement","arguments":{"entry":"recipient-entry"}}}'
          : "Check agreement for council.";
      return route.fulfill({
        json: { choices: [{ message: { content }, finish_reason: "stop" }] },
      });
    });
    await launch(receiver, {
      locale: "en-US",
      files: { [recipientDraft]: recipientText },
      openedPaths: [{ path: recipientDraft, kind: "file" }],
    });
    await connect(receiver, "Recipient fixture", ownEndpoint);
    await receiver.locator(".cm-content:visible").press("ControlOrMeta+A");
    await runMenuItem(receiver, "edit.writingSkills");
    const ask = receiver.getByRole("region", { name: "Ask AI" });
    await pickFile(receiver, ask.getByRole("button", { name: "Import skill" }), {
      name: "agreement.mint-skill.json",
      buffer: Buffer.from(exported),
      mimeType: "application/json",
    });
    const review = ask.getByRole("group", { name: "Review imported skill" });
    await expect(review).toContainText("Current selection");
    await expect(review).toContainText("check_agreement");
    await expect(review).toContainText("Read external information");
    await expect(review).toContainText("Comment only");
    expect(received).toEqual([]);
    await review.getByRole("button", { name: "Save skill" }).click();
    await ask.getByRole("button", { name: "/agreement · Agreement" }).click();
    await ask.getByText("MCP tools", { exact: true }).click();
    await expect(ask.getByLabel("MCP endpoint")).toHaveValue("");
    await ask.getByLabel("MCP endpoint").fill(ownTool);
    await ask.getByRole("button", { name: "Find tools" }).click();
    await ask
      .getByRole("combobox", { name: "MCP tool", exact: true })
      .selectOption("check_agreement");
    await ask.getByRole("combobox", { name: "External effect" }).selectOption("read");
    await expect(ask.getByLabel("Exact arguments to authorize")).toHaveValue("");
    await ask.getByText("Add files or paste text").click();
    await ask.getByLabel("Pasted material").fill(ownMaterial);
    await ask.getByRole("button", { name: "Add pasted text" }).click();
    await ask
      .getByRole("button", { name: /Comment only · Current selection · Recipient fixture/ })
      .click();
    const approval = ask.getByRole("group", { name: "External tool approval" });
    await expect(approval).toContainText(ownTool);
    await expect(approval).toContainText("recipient-entry");
    expect(ownCalls).toEqual([]);
    await approval.getByRole("button", { name: "Allow this tool call" }).click();
    await expect(ask.getByRole("textbox", { name: "AI reply", exact: true })).toHaveValue(
      "Check agreement for council.",
    );
    expect(received[0]).toEqual({
      instruction: expect.stringContaining("List each error and its correction."),
      selectedText: recipientText,
      taskContext: { materials: [{ name: "Pasted text", text: ownMaterial }] },
    });
    expect(received[1]?.instruction).toContain("The recipient approved this reference.");
    expect(ownCalls).toEqual([
      { name: "check_agreement", arguments: { entry: "recipient-entry" } },
    ]);
    expect(toolCalls).toEqual([{ name: "check_agreement", arguments: { entry: "author-entry" } }]);
  } finally {
    await receiver.close();
  }
});
