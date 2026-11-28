import { expect, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

test("automatic proofreading locates and applies one undoable correction", async ({ page }) => {
  const address = "https://proofreading.example.test/v1";
  const endpoint = `${address}/chat/completions`;
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

  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Proofreading fixture");
  await settings.getByLabel("API address").fill(address);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await settings
    .getByLabel("Proofreading model")
    .selectOption({ label: `Proofreading fixture · ${address}` });
  const toggle = settings.getByRole("checkbox", { name: "Automatic proofreading" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
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
  const release = Promise.withResolvers<void>();
  let requests = 0;
  await page.route(endpoint, async (route) => {
    requests++;
    await release.promise;
    await route.fulfill({ json: reply });
  });
  const delayed = page.waitForRequest(endpoint);
  await page.keyboard.press("End");
  await page.keyboard.insertText(" More notes.");
  await delayed;
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page
    .getByRole("combobox", { name: "Command Palette" })
    .fill("toggle automatic proofreading");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => JSON.parse((await readFile(page, settingsPath)) ?? "{}").proofreading)
    .toBe(false);
  const delivered = page.waitForResponse(endpoint);
  release.resolve();
  await delivered;
  await expect(editor).toBeFocused();
  await page.clock.install();
  await page.keyboard.insertText(" Still writing.");
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe(text.replace("  \r\n", "   More notes. Still writing.\r\n"));
  await page.clock.runFor(3000);
  await expect(suggestion).toBeHidden();
  expect(requests).toBe(1);
});
