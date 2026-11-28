import { expect, type Page, type Route, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

const address = "https://proofreading.example.test/v1";
const endpoint = `${address}/chat/completions`;
const modelName = "Proofreading fixture";

async function enableProofreading(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill(modelName);
  await settings.getByLabel("API address").fill(address);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await settings.getByLabel("Proofreading model").selectOption({ label: modelName });
  await expect(settings.getByText(`Sends to ${address}`, { exact: true })).toBeVisible();
  const toggle = settings.getByRole("checkbox", { name: "Automatic proofreading" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  return { settings, toggle };
}

test("automatic proofreading locates and applies one undoable correction", async ({ page }) => {
  const path = "/notes/draft.md";
  const text = "\uFEFFThe birds is here.  \r\n\r\nThe birds is everywhere.\n";
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({ original: "birds is", replacement: "birds are" }),
            },
          },
        ],
      },
    }),
  );
  await launch(page, {
    files: { [path]: text, [settingsPath]: JSON.stringify({ autosave: false, spellcheck: false }) },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await expect(editor).toBeFocused();

  const { settings, toggle } = await enableProofreading(page);
  const inline = settings.getByLabel("Inline completion", { exact: true });
  await expect(inline).toHaveValue("");
  const [sent] = await Promise.all([
    page.waitForRequest(endpoint),
    settings.getByRole("button", { name: "Close", exact: true }).click(),
  ]);
  expect(sent.postDataJSON().model).toBe("fixture-model");
  expect(JSON.parse(sent.postDataJSON().messages[0].content).selectedText).toBe(
    "The birds is here.",
  );

  const suggestion = page.getByRole("region", { name: "Proofreading suggestion" });
  await expect(suggestion).toContainText("birds are");
  await expect(editor).toBeFocused();
  await suggestion.getByRole("button", { name: "Show in document" }).click();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("birds is");
  await suggestion.getByRole("button", { name: "Apply correction" }).click();
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(text.replace("birds is", "birds are"));

  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(text);

  // Hold a reply across the Edit command to prove that it cannot restore a hint after disable.
  const reply = {
    choices: [{ message: { content: '{"original":"birds is","replacement":"birds are"}' } }],
  };
  const pending: Route[] = [];
  await page.route(endpoint, (route) => {
    pending.push(route);
  });
  await page.keyboard.press("End");
  await page.keyboard.type(" More notes.");
  await expect.poll(() => pending.length).toBe(1);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page
    .getByRole("combobox", { name: "Command Palette" })
    .fill("toggle automatic proofreading");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => JSON.parse((await readFile(page, settingsPath)) ?? "{}").proofreading)
    .toBe(false);
  const held = pending[0];
  if (!held) throw new Error("The proofreading request did not reach the fixture");
  await held.fulfill({ json: reply });
  await expect(editor).toBeFocused();
  await page.keyboard.type(" Still writing.");
  await expect(editor).toContainText("Still writing.");
  await page.waitForTimeout(1200);
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe(text.replace("  \r\n", "   More notes. Still writing.\r\n"));
  await expect(suggestion).toBeHidden();
  expect(pending).toHaveLength(1);

  await page.unroute(endpoint);
  await page.route(endpoint, (route) =>
    route.fulfill({ json: { choices: [{ message: { content: " across the ridge." } }] } }),
  );
  await page.keyboard.press("ControlOrMeta+,");
  await inline.selectOption({ label: modelName });
  await expect(toggle).not.toBeChecked();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await editor.click();
  await page.keyboard.type(" We walked");
  await expect(editor.getByText("across the ridge.", { exact: true })).toBeVisible();
  await expect(suggestion).toBeHidden();
});

test("automatic proofreading waits for committed IME text", async ({ page }) => {
  const text = "山路通像河谷";
  const passages: string[] = [];
  await page.route(endpoint, async (route) => {
    passages.push(JSON.parse(route.request().postDataJSON().messages[0].content).selectedText);
    await route.fulfill({
      json: { choices: [{ message: { content: '{"original":"通像","replacement":"通向"}' } }] },
    });
  });
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+N");
  const { settings } = await enableProofreading(page);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await editor.click();
  const input = await page.context().newCDPSession(page);
  await input.send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
  await expect(editor).toHaveText(text);
  await page.waitForTimeout(1100);
  expect(passages).toEqual([]);
  await input.send("Input.insertText", { text });
  await expect(page.getByRole("region", { name: "Proofreading suggestion" })).toContainText("通向");
  expect(passages).toEqual([text]);
});
