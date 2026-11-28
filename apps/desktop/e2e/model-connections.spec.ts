import { expect, test } from "@playwright/test";
import { files, launch } from "./memory-platform.ts";

test("a model can be used for this launch when the credential store is unavailable", async ({
  page,
}) => {
  const address = "https://model.example.test/v1";
  const endpoint = `${address}/chat/completions`;
  const key = "launch-fixture-8842";
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: { choices: [{ message: { content: "Sample received." }, finish_reason: "stop" }] },
    }),
  );
  await launch(page, { locale: "en-US", files: { "/draft.md": "Private manuscript" } });

  const settings = page.getByRole("dialog", { name: "Settings" });
  async function openConnections() {
    await page.keyboard.press("ControlOrMeta+,");
    await settings.getByRole("button", { name: "Model connections" }).click();
  }

  await openConnections();
  await settings.getByLabel("Connection name").fill("Lab model");
  await settings.getByLabel("API address").fill(address);
  await settings.getByLabel("Model name").fill("fixture-model");
  const password = settings.getByLabel("API key");
  await password.fill(key);
  await settings.getByRole("button", { name: "Remember connection" }).click();
  await expect(settings.getByRole("alert")).toContainText("System credential store is unavailable");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  const saved = settings.getByRole("region", { name: "Lab model" });
  await expect(saved.getByText("Use for this launch")).toBeVisible();
  await expect(saved.getByText("••••8842")).toBeVisible();
  await expect(settings.getByText(key, { exact: false })).toHaveCount(0);
  await expect(password).toHaveValue("");

  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await openConnections();
  const request = page.waitForRequest(endpoint);
  await saved.getByRole("button", { name: "Run sample" }).click();
  await expect(saved.getByText("Sample received.")).toBeVisible();
  expect((await request).headers().authorization).toBe(`Bearer ${key}`);
  expect(JSON.stringify(await files(page))).not.toContain(key);
  expect(await files(page)).toMatchObject({ "/draft.md": "Private manuscript" });

  await page.reload();
  await openConnections();
  await expect(settings.getByRole("region", { name: "Lab model" })).toHaveCount(0);
});
