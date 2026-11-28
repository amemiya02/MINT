import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

test("a background edit keeps complete suggestions and partial replies across stops and retries", async ({
  page,
}) => {
  const draft = "/notes/origin.md";
  const other = "/notes/other.md";
  const original = "It was a very slow start.";
  const replacement = "<replacement>It was a slow start.</replacement>";
  const partial = " An unfinished explanation";
  const requests: { recipient: string; body: Record<string, unknown> }[] = [];
  let stopped = false;
  let disconnect: (() => void) | undefined;
  const delta = (response: ServerResponse, content: string, finish_reason?: string) =>
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\n\n`,
    );
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      recipient: request.url ?? "",
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requests.length === 1) {
      response.once("close", () => {
        stopped = !response.writableEnded;
      });
      delta(response, replacement.slice(0, 20));
      delta(response, replacement.slice(20) + partial);
    } else if (requests.length === 2) {
      disconnect = () => response.destroy();
      delta(response, `${replacement} A dropped reply`);
    } else if (requests.length === 3) {
      delta(response, replacement, "length");
      response.end("data: [DONE]\n\n");
    } else {
      delta(response, "<replacement>The start was slow.</replacement>", "stop");
      response.end("data: [DONE]\n\n");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    await launch(page, {
      locale: "en-US",
      files: {
        [draft]: original,
        [other]: "Other manuscript.",
        [settingsPath]: '{"autosave":false}',
      },
      openedPaths: [{ path: draft, kind: "file" }],
      openDialogResults: [other],
    });
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Model connections" }).click();
    for (const name of ["First model", "Second model"]) {
      await settings.getByLabel("Connection name").fill(name);
      await settings
        .getByLabel("API address")
        .fill(`http://127.0.0.1:${address.port}/${name.split(" ")[0]}/v1`);
      await settings.getByLabel("Model name").fill("fixture-writer");
      await settings.getByRole("button", { name: "Use for this launch" }).click();
      await expect(settings.getByRole("region", { name })).toBeVisible();
    }
    await settings.getByRole("button", { name: "Close" }).click();

    const editor = page.getByRole("tabpanel", { name: "origin.md" }).locator(".cm-content");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    const inline = page.getByRole("region", { name: "Ask AI" });
    await inline.getByLabel("Recipient").selectOption({
      label: `First model · http://127.0.0.1:${address.port}/First/v1/chat/completions`,
    });
    await inline
      .getByRole("textbox", { name: "Instruction" })
      .fill("Tighten the sentence, apply directly");
    await inline.getByRole("textbox", { name: "Instruction" }).press("Enter");
    await expect(inline.getByText(partial.trim(), { exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+O");
    const otherEditor = page.getByRole("tabpanel", { name: "other.md" }).locator(".cm-content");
    await expect(otherEditor).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" I can keep writing.");
    const tasks = page.getByRole("region", { name: "Writing tasks" });
    await expect(tasks).toContainText("origin.md");
    await expect(tasks).toContainText("Current selection");
    await expect(tasks).toContainText("1 suggestion");
    await tasks.getByRole("button", { name: "Stop generation" }).click();
    await expect.poll(() => stopped).toBe(true);
    await expect(tasks).toContainText("Stopped");
    await expect(otherEditor).toHaveText("Other manuscript. I can keep writing.");

    await tasks.getByRole("button", { name: "Open task for origin.md" }).click();
    const conversation = page.getByRole("complementary", { name: "Writing Assistant" });
    await expect(conversation.getByText(partial.trim(), { exact: true })).toBeVisible();
    const materials = conversation.getByRole("group", { name: "Task materials" });
    await materials.getByText("Task materials", { exact: true }).click();
    await materials.getByText("Current selection", { exact: true }).click();
    await expect(materials.getByText(original, { exact: true })).toBeVisible();
    await expect(editor).toHaveText(original);
    await conversation.getByRole("button", { name: "Apply proposed edit" }).click();
    await expect(editor).toHaveText("It was a slow start.");
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(editor).toHaveText(original);

    await conversation.getByRole("button", { name: "Retry generation", exact: true }).click();
    await expect(conversation.getByText("A dropped reply", { exact: true })).toBeVisible();
    disconnect?.();
    await expect(conversation.getByText("Connection interrupted", { exact: true })).toBeVisible();
    await conversation.getByLabel("Retry connection").selectOption({
      label: `Second model · http://127.0.0.1:${address.port}/Second/v1/chat/completions`,
    });
    await conversation.getByRole("button", { name: "Retry with selected connection" }).click();
    await expect(conversation.getByText("Generation limit reached", { exact: true })).toBeVisible();
    await expect(conversation.getByRole("button", { name: "Apply proposed edit" })).toHaveCount(0);
    await expect(editor).toHaveText(original);
    expect(await readFile(page, draft)).toBe(original);
    await conversation.getByRole("button", { name: "Retry generation", exact: true }).click();
    await conversation.getByRole("button", { name: "Apply proposed edit" }).click();
    await expect(editor).toHaveText("The start was slow.");
    await page.keyboard.press("ControlOrMeta+S");
    await expect.poll(() => readFile(page, draft)).toBe("The start was slow.");
    expect(requests.map(({ recipient }) => recipient)).toEqual([
      "/First/v1/chat/completions",
      "/First/v1/chat/completions",
      "/Second/v1/chat/completions",
      "/Second/v1/chat/completions",
    ]);
    expect(requests[0]?.body.stream).toBe(true);
    expect(requests.slice(1).map(({ body }) => body)).toEqual([
      requests[0]?.body,
      requests[0]?.body,
      requests[0]?.body,
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
