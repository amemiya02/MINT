import { expect, test } from "@playwright/test";
import { files, launch } from "./memory-platform.ts";

test("try a model with sample text, correct the key and verify the returned capabilities", async ({
  page,
}) => {
  const apiBase = "https://model.example.test/v1";
  const endpoint = `${apiBase}/chat/completions`;
  const requests: { method: string; key?: string; body: unknown }[] = [];
  await page.route(endpoint, async (route) => {
    const request = route.request();
    const key = request.headers().authorization;
    requests.push({ method: request.method(), key, body: request.postDataJSON() });
    if (key !== "Bearer fixture-key") {
      await route.fulfill({ status: 401, json: { error: { message: "Invalid key" } } });
      return;
    }
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"<replacement>The team "}}]}',
        'data: {"choices":[{"delta":{"content":"reviewed the results.</replacement>"},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
  });
  await launch(page, { locale: "en-US", files: { "/draft.md": "Private manuscript" } });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  const provider = settings.getByLabel("Model service");
  await provider.selectOption({ label: "OpenAI" });
  await expect(settings.getByLabel("API address")).toHaveValue("https://api.openai.com/v1");
  await provider.selectOption({ label: "Ollama (local)" });
  await expect(settings.getByLabel("API address")).toHaveValue("http://127.0.0.1:11434/v1");
  await provider.selectOption({ label: "Custom compatible service" });
  await settings.getByLabel("API address").fill(apiBase);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByLabel("Connection name").fill("Tested model");
  const key = settings.getByLabel("API key");
  await key.fill("wrong-fixture-key");
  const sample = await settings.getByLabel("Sample prompt").inputValue();
  expect(sample).toContain("The research team met again to discuss the results.");
  const send = settings.getByRole("button", { name: "Run sample" });
  await send.click();
  await expect(settings.getByRole("alert")).toContainText("Check the API key");
  await expect(settings.getByText("Conversation: Unverified")).toBeVisible();

  await key.fill("fixture-key");
  await send.click();
  await expect(settings.getByText("The team reviewed the results.", { exact: true })).toBeVisible();
  await expect(settings.getByText("Conversation: Verified")).toBeVisible();
  await expect(settings.getByText("Streaming: Verified")).toBeVisible();
  await expect(settings.getByText("Proposed edit: Verified")).toBeVisible();
  await expect(settings.getByText("Multi-file editing: Unavailable")).toBeVisible();
  await expect(key).toHaveValue("");
  const remember = settings.getByRole("button", { name: "Remember connection" });
  const useForLaunch = settings.getByRole("button", { name: "Use for this launch" });
  await expect(remember).toBeDisabled();
  await expect(useForLaunch).toBeDisabled();
  await expect(settings.getByText("Re-enter the API key to save this connection.")).toBeVisible();
  await key.fill("fixture-key");
  await expect(remember).toBeEnabled();
  await expect(useForLaunch).toBeEnabled();
  expect(requests).toEqual(
    ["wrong-fixture-key", "fixture-key"].map((credential) => ({
      method: "POST",
      key: `Bearer ${credential}`,
      body: {
        model: "fixture-model",
        messages: [{ role: "user", content: sample }],
        stream: true,
      },
    })),
  );
  expect(JSON.stringify(await files(page))).not.toContain("fixture-key");

  const localEndpoint = "http://127.0.0.1:11434/v1/chat/completions";
  await page.route(localEndpoint, (route) =>
    route.fulfill({
      json: { choices: [{ message: { content: "I would remove the redundant words." } }] },
    }),
  );
  await provider.selectOption({ label: "Ollama (local)" });
  await settings.getByLabel("Model name").fill("local-fixture");
  await settings.getByLabel("Request streaming").uncheck();
  const [localRequest] = await Promise.all([page.waitForRequest(localEndpoint), send.click()]);
  expect(localRequest.headers().authorization).toBeUndefined();
  expect(localRequest.postDataJSON()).toEqual({
    model: "local-fixture",
    messages: [{ role: "user", content: sample }],
    stream: false,
  });
  await expect(settings.getByText("I would remove the redundant words.")).toBeVisible();
  await expect(settings.getByText("Conversation: Verified")).toBeVisible();
  await expect(settings.getByText("Streaming: Unverified")).toBeVisible();
  await expect(settings.getByText("Proposed edit: Unverified")).toBeVisible();
});
