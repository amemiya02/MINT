import { expect, test } from "@playwright/test";
import { launch } from "./memory-platform.ts";

const mcp = "https://tools.example.test/mcp";
const model = "https://writing.example.test/v1";

test("MCP sends only the reviewed action to the chosen endpoint", async ({ page }) => {
  const calls: unknown[] = [];
  const outcomes: string[] = [];
  const tool = {
    name: "update_entry",
    description: "Replace text in a library entry.",
    inputSchema: { type: "object", properties: { entry: { type: "string" } } },
  };
  const read = { ...tool, name: "read_entry", description: "Read a library entry." };
  await page.route(mcp, async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    if (method === "notifications/initialized") return route.fulfill({ status: 202 });
    if (method === "tools/call") calls.push(params);
    const result =
      method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
        : method === "tools/list"
          ? { tools: [tool, read] }
          : { content: [{ type: "text", text: "Updated the authorized entry." }] };
    await route.fulfill({ json: { jsonrpc: "2.0", id, result } });
  });
  await page.route(`${model}/chat/completions`, (route) => {
    const { messages, stream } = route.request().postDataJSON();
    const prompt = messages.at(-1).content;
    if (prompt.includes("Interrupted:")) {
      if (!stream) return route.fulfill({ status: 503 });
      const event = { choices: [{ delta: { content: "The trail reopened this morning." } }] };
      return route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify(event)}\n\n`,
      });
    }
    const outcome = /MCP tool outcome \(source data\): (\{.*\})\. Continue/.exec(prompt)?.[1];
    if (outcome) outcomes.push(JSON.parse(outcome).status);
    const reply = outcome
      ? "Trail update ready."
      : JSON.stringify({
          requestTool: {
            name: prompt.includes("Read:") ? read.name : tool.name,
            arguments: { entry: prompt.includes("Outside") ? "other-entry" : "trail-notes" },
          },
        });
    return route.fulfill({
      json: { choices: [{ message: { content: reply }, finish_reason: "stop" }] },
    });
  });

  const expectedCalls: { name: string; arguments: { entry: string } }[] = [];
  for (const scenario of ["Deny", "Outside", "Approve", "Read", "Interrupted"]) {
    await launch(page, { locale: "en-US" });
    await page.getByRole("button", { name: "Draft with AI" }).click();
    const composer = page.getByRole("form", { name: "Draft with AI" });
    await composer.getByLabel("API address").fill(model);
    await composer.getByLabel("Model name").fill("fixture");
    await composer.getByLabel("Drafting instruction").fill(`${scenario}: draft a trail update.`);
    await composer.getByText("MCP tools", { exact: true }).click();
    await composer.getByLabel("MCP endpoint").fill(mcp);
    await composer.getByRole("button", { name: "Find tools" }).click();
    const selected = scenario === "Read" ? read : tool;
    await composer
      .getByRole("combobox", { name: "MCP tool", exact: true })
      .selectOption(selected.name);
    await expect(composer.getByText(selected.description)).toBeVisible();
    await composer
      .getByRole("combobox", { name: "External effect" })
      .selectOption(scenario === "Read" ? "read" : "modify");
    if (scenario === "Approve" || scenario === "Outside") {
      await composer.getByLabel("Exact arguments to authorize").fill('{"entry":"trail-notes"}');
    }
    expect(calls).toEqual(expectedCalls);
    await composer.getByRole("button", { name: /^Generate draft/ }).click();

    if (scenario === "Deny" || scenario === "Read") {
      const approval = page.getByRole("group", { name: "External tool approval" });
      await expect(approval.getByText(mcp, { exact: true })).toBeVisible();
      await expect(
        approval.getByText(
          scenario === "Read" ? "Read external information" : "Modify an external target",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(approval.getByText(/trail-notes/)).toBeVisible();
      await expect(approval.getByText(/writing\.example\.test/)).toBeVisible();
      expect(calls).toEqual(expectedCalls);
      await approval
        .getByRole("button", {
          name: scenario === "Read" ? "Allow this tool call" : "Deny tool call",
        })
        .click();
    }
    if (scenario === "Interrupted") {
      await expect(composer.getByRole("button", { name: "Retry generation" })).toBeVisible();
      await expect(composer.getByRole("region", { name: "Incomplete reply" })).toHaveText(
        "The trail reopened this morning.",
      );
    } else {
      await expect(page.getByRole("tabpanel")).toContainText("Trail update ready.");
    }
    await expect(page.getByRole("group", { name: "External tool approval" })).toHaveCount(0);
    if (scenario === "Approve" || scenario === "Read") {
      expectedCalls.push({ name: selected.name, arguments: { entry: "trail-notes" } });
    }
    expect(calls).toEqual(expectedCalls);
  }
  expect(outcomes).toEqual(["denied", "outside", "done", "done"]);
});

test("an Agent proposal can send only the manuscript text the author reviews", async ({ page }) => {
  const path = "/opt/agents/codex";
  const passage = "Publish this excerpt.";
  const tool = {
    name: "send_excerpt",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  };
  const calls: unknown[] = [];
  await page.route(mcp, async (route) => {
    const { id, method, params } = route.request().postDataJSON();
    if (method === "notifications/initialized") return route.fulfill({ status: 202 });
    if (method === "tools/call") calls.push(params);
    const result =
      method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
        : method === "tools/list"
          ? { tools: [tool] }
          : { content: [{ type: "text", text: "Excerpt sent." }] };
    await route.fulfill({ json: { jsonrpc: "2.0", id, result } });
  });
  await page.route("**/__test/external-tool-agent", (route) => {
    const { request } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        text: request.instruction.includes("MCP tool outcome")
          ? "The reviewed excerpt was sent."
          : JSON.stringify({
              requestTool: { name: tool.name, arguments: { text: request.selectedText } },
            }),
      },
    });
  });
  await launch(page, {
    locale: "en-US",
    files: { "/draft.md": `Private paragraph.\n\n${passage}` },
    openedPaths: [{ path: "/draft.md", kind: "file" }],
    externalAgent: { executables: [path], endpoint: "/__test/external-tool-agent" },
  });
  await page.locator(".cm-content").getByText(passage, { exact: true }).click();
  await page.keyboard.press("End");
  for (const _ of passage) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox").fill("Ask External Agent");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Ask External Agent" });
  await dialog.getByLabel("Codex executable").fill(path);
  await dialog.getByRole("button", { name: "Inspect Agent" }).click();
  await dialog.getByLabel("Instruction").fill("Publish the selected excerpt.");
  await dialog.getByText("MCP tools", { exact: true }).click();
  await dialog.getByLabel("MCP endpoint").fill(mcp);
  await dialog.getByRole("button", { name: "Find tools" }).click();
  await dialog.getByRole("combobox", { name: "MCP tool", exact: true }).selectOption(tool.name);
  await dialog.getByRole("combobox", { name: "External effect" }).selectOption("send");
  await dialog.getByRole("button", { name: "Send selection" }).click();
  await dialog.getByRole("button", { name: "Allow and send" }).click();
  const approval = dialog.getByRole("group", { name: "External tool approval" });
  await expect(approval.getByText("Send manuscript text to another service")).toBeVisible();
  await expect(approval.getByText(/Publish this excerpt/)).toBeVisible();
  await expect(approval.getByText(/Private paragraph/)).toHaveCount(0);
  expect(calls).toEqual([]);
  await approval.getByRole("button", { name: "Allow this tool call" }).click();
  await expect(dialog.getByRole("textbox", { name: "AI reply" })).toHaveValue(
    "The reviewed excerpt was sent.",
  );
  expect(calls).toEqual([{ name: tool.name, arguments: { text: passage } }]);
});
