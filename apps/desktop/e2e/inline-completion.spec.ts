import { expect, type Page, type Route, test } from "@playwright/test";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

const address = "https://completion.example.test/v1";
const endpoint = `${address}/chat/completions`;
const draft = "/draft.md";
const connectionName = "Writing model";

async function openSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  return page.getByRole("dialog", { name: "Settings" });
}

async function enableCompletion(page: Page, beforeClose?: () => Promise<void>) {
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill(connectionName);
  await settings.getByLabel("API address").fill(address);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await settings.getByLabel("Inline completion").selectOption({ label: connectionName });
  await beforeClose?.();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
}

function response(text: string) {
  return { json: { choices: [{ message: { content: text }, finish_reason: "stop" }] } };
}

test("typing while the writing connection loads still produces a continuation", async ({
  page,
}) => {
  const received: string[] = [];
  await page.route(endpoint, (route) => {
    received.push(route.request().postDataJSON().messages.at(-1).content);
    return route.fulfill(response(" leads to the ridge"));
  });
  await launch(page, {
    locale: "en-US",
    files: { [draft]: "The" },
    openedPaths: [{ path: draft, kind: "file" }],
  });
  let release!: () => void;
  const connectionReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.exposeFunction("waitForCompletionConnection", () => connectionReady);
  await enableCompletion(page, () =>
    page.evaluate(() => {
      const { __MINT_MEMORY_PLATFORM__: platform, waitForCompletionConnection } =
        window as unknown as {
          __MINT_MEMORY_PLATFORM__: MemoryPlatform;
          waitForCompletionConnection(): Promise<void>;
        };
      const list = platform.listModelConnections;
      platform.listModelConnections = async () => {
        await waitForCompletionConnection();
        return list();
      };
    }),
  );
  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await editor.press("End");
  await page.keyboard.type(" trail");
  await expect(editor).toHaveText("The trail");
  release();
  await expect(editor.getByText("leads to the ridge", { exact: true })).toBeVisible();
  expect(received).toEqual([JSON.stringify({ before: "The trail", after: "" })]);
});

test("a paused writer can accept a faint continuation with Tab and undo it", async ({ page }) => {
  await page.route(endpoint, (route) => route.fulfill(response(" leads to the ridge")));
  await launch(page, {
    locale: "en-US",
    files: { [draft]: "# Route\r\n\r\nThe. Bring boots.", [settingsPath]: '{"autosave":false}' },
    openDialogResults: [draft],
  });
  await page.keyboard.press("ControlOrMeta+O");
  const editor = page.getByRole("textbox");
  await expect(editor).toBeFocused();
  await enableCompletion(page);
  await editor.press("ControlOrMeta+End");
  await editor.press("Home");
  for (let i = 0; i < 3; i++) await editor.press("ArrowRight");
  const sent = page.waitForRequest(endpoint);
  await page.keyboard.type(" trail");

  await expect(editor.getByText("leads to the ridge", { exact: true })).toBeVisible();
  expect((await sent).postDataJSON()).toMatchObject({
    model: "fixture-model",
    messages: expect.arrayContaining([
      {
        role: "user",
        content: JSON.stringify({ before: "# Route\n\nThe trail", after: ". Bring boots." }),
      },
    ]),
  });
  await editor.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, draft)).toBe("# Route\r\n\r\nThe trail. Bring boots.");

  await editor.press("Tab");
  await expect(editor).toBeFocused();
  await expect(editor).toContainText("The trail leads to the ridge. Bring boots.");
  await editor.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, draft))
    .toBe("# Route\r\n\r\nThe trail leads to the ridge. Bring boots.");
  await editor.press("ControlOrMeta+Z");
  await expect(editor).toContainText("The trail. Bring boots.");
});

test("only the latest pause can offer a suggestion, and Off stops requests", async ({ page }) => {
  const pending: Route[] = [];
  await page.route(endpoint, (route) => {
    pending.push(route);
  });
  await launch(page, {
    locale: "en-US",
    files: { [draft]: "The", "/notes.md": "Separate notes" },
    openDialogResults: [draft, "/notes.md"],
  });
  await page.keyboard.press("ControlOrMeta+O");
  const editor = page.getByRole("textbox");
  await expect(editor).toBeFocused();
  await enableCompletion(page);
  await editor.press("End");
  await page.keyboard.type(" trail bends", { delay: 75 });
  await expect.poll(() => pending.length).toBe(1);
  expect(pending[0]?.request().postDataJSON().messages[1].content).toBe(
    JSON.stringify({ before: "The trail bends", after: "" }),
  );

  // Keep the caret offset the same to exercise invalidation when only its context changed.
  await page.keyboard.press("Shift+Home");
  await page.keyboard.type("The trail winds");
  await expect.poll(() => pending.length).toBe(2);
  await pending[1]?.fulfill(response(" past the creek."));
  const latest = editor.getByText("past the creek.", { exact: true });
  await expect(latest).toBeVisible();
  await pending[0]?.fulfill(response(" starts here."));
  // Allow the obsolete response to reach the editor while the new suggestion is visible.
  await page.waitForTimeout(200);
  await expect(latest).toBeVisible();
  await expect(editor).not.toContainText("starts here.");
  await editor.press("Escape");
  await expect(editor).toHaveText("The trail winds");
  await expect(editor).toBeFocused();

  await page.keyboard.type(" uphill");
  await expect.poll(() => pending.length).toBe(3);
  await page.keyboard.press("ControlOrMeta+O");
  await expect(editor).toHaveText("Separate notes");
  await pending[2]?.fulfill(response(" after the bend."));
  await page.waitForTimeout(200);
  await expect(editor).toHaveText("Separate notes");
  await expect(editor).toBeFocused();
  await page.getByRole("tab", { name: /draft\.md/ }).click();
  await expect(editor).toHaveText("The trail winds uphill");

  const settings = await openSettings(page);
  await settings.getByLabel("Inline completion").selectOption({ label: "Off" });
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" today");
  await page.waitForTimeout(750);
  expect(pending).toHaveLength(3);
  await expect(editor).toHaveText("The trail winds uphill today");
});

test("inline completion waits for IME text to be committed", async ({ page }) => {
  const requests: string[] = [];
  await page.route(endpoint, async (route) => {
    requests.push(route.request().postDataJSON().messages[1].content);
    await route.fulfill(response("穿过河谷。"));
  });
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+N");
  await enableCompletion(page);
  const editor = page.getByRole("textbox");
  await editor.click();
  const input = await page.context().newCDPSession(page);
  await input.send("Input.imeSetComposition", { text: "山路", selectionStart: 2, selectionEnd: 2 });
  await expect(editor).toContainText("山路");
  await page.waitForTimeout(750);
  expect(requests).toHaveLength(0);
  await input.send("Input.insertText", { text: "山路" });
  await expect(editor.getByText("穿过河谷。", { exact: true })).toBeVisible();
  expect(requests).toEqual([JSON.stringify({ before: "山路", after: "" })]);
});
