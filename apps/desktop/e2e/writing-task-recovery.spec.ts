import { expect, test } from "@playwright/test";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

const path = "/notes/review.md";
const endpoint = "https://review.example.test/v1/chat/completions";
const instruction = "Review the four passages.";
type MintWindow = { __MINT_MEMORY_PLATFORM__: MemoryPlatform };

test("a writing task resumes decisions, materials and reading position after a restart", async ({
  page,
  browser,
}) => {
  const source = "First draft.\n\nSecond draft.\n\nThird draft.\n\nLast draft.";
  let calls = 0;
  await page.route(endpoint, (route) => {
    calls++;
    if (calls === 1) expect(route.request().postData()).toContain("Field notes from Tuesday.");
    return route.fulfill({
      json: {
        choices: [
          {
            message: {
              content:
                "<replacement>First revision.\n\nSecond revision.\n\nThird revision.\n\nLast revision.</replacement>",
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  const seed = {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" as const }],
  };
  await launch(page, seed);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Review fixture");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Review fixture" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();

  const editor = page.locator(".cm-content");
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const review = page.getByRole("region", { name: "Ask AI" });
  await review.getByText("Add files or paste text", { exact: true }).click();
  await review.getByRole("textbox", { name: "Pasted material" }).fill("Field notes from Tuesday.");
  await review.getByRole("button", { name: "Add pasted text", exact: true }).click();
  await review.getByRole("textbox", { name: "Instruction" }).fill(instruction);
  await review.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await review
    .getByRole("group", { name: "Proposed edit 1 of 4" })
    .getByRole("button", { name: "Apply proposed edit", exact: true })
    .click();
  await review
    .getByRole("group", { name: "Proposed edit 2 of 4" })
    .getByRole("button", { name: "Dismiss proposed edit" })
    .click();
  await editor.press("ControlOrMeta+End");
  await editor.press("ControlOrMeta+S");
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await review.getByRole("textbox", { name: "Instruction" }).fill("Keep this other task.");
  await review.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect(review.getByRole("button", { name: "Continue in sidebar" })).toBeVisible();
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Writing tasks", exact: true }).click();
  await expect(page.getByRole("button", { name: instruction, exact: true })).toBeVisible();

  const appData = await page.evaluate(() =>
    Object.fromEntries((window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__.appData),
  );
  const rebooted = await browser.newContext();
  try {
    await rebooted.route(endpoint, (route) => {
      calls++;
      return route.abort();
    });
    const resumed = await rebooted.newPage();
    const changed =
      "New opening note.\n\nFirst revision.\n\nSecond draft.\n\nExternally changed third.\n\nLast draft.";
    await launch(resumed, { ...seed, appData, files: { ...seed.files, [path]: changed } });
    await runMenuItem(resumed, "edit.writingTasks");
    await resumed.getByRole("button", { name: instruction, exact: true }).click();

    const assistant = resumed.getByRole("complementary", { name: "Writing Assistant" });
    const edit = (position: number) =>
      assistant.getByRole("group", {
        name: `Proposed edit ${position} of 4`,
      });
    await expect(edit(1)).toContainText("Applied");
    await expect(edit(2)).toContainText("Proposed edit dismissed.");
    await expect(edit(3).getByText("Externally changed third.", { exact: true })).toBeVisible();
    await expect(edit(3).getByRole("button", { name: "Apply to compared text" })).toBeVisible();
    await expect(
      edit(4).getByRole("button", { name: "Apply proposed edit", exact: true }),
    ).toBeVisible();
    await assistant.getByText("Pasted text", { exact: true }).click();
    await expect(assistant.getByText("Field notes from Tuesday.", { exact: true })).toBeVisible();
    await assistant.getByRole("button", { name: "Close", exact: true }).click();
    expect(await resumed.evaluate(() => window.getSelection()?.focusNode?.textContent)).toBe(
      "Last draft.",
    );
    expect(calls).toBe(2);

    await resumed.getByRole("button", { name: "Writing tasks", exact: true }).click();
    const dialog = resumed.getByRole("dialog", { name: "Writing tasks" });
    const remove = dialog.getByRole("button", { name: `Delete ${instruction}`, exact: true });
    await expect(remove).toBeVisible({ timeout: 4000 });
    await remove.click();
    await dialog.getByRole("button", { name: "Delete task", exact: true }).click();
    await expect(dialog.getByRole("button", { name: instruction, exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Keep this other task.", exact: true }),
    ).toBeVisible();
    expect(await readFile(resumed, path)).toBe(changed);
    const preserved = await resumed.evaluate(async (path) => {
      const platform = (window as unknown as MintWindow).__MINT_MEMORY_PLATFORM__;
      const [id] = await platform.listVersions(path);
      return {
        version: id === undefined ? null : await platform.readVersion(path, id),
        privateData: JSON.stringify(Object.fromEntries(platform.appData)),
      };
    }, path);
    expect(preserved.version).toContain("First revision.");
    expect(preserved.privateData).not.toContain("Field notes from Tuesday.");
    expect(calls).toBe(2);
  } finally {
    await rebooted.close();
  }
});
