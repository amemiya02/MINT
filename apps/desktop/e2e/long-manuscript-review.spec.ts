import { expect, type Locator, type Page, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

const path = "/notes/manuscript.md";
const endpoint = "https://review.example.test/v1/chat/completions";

async function tabTo(page: Page, control: Locator) {
  for (let index = 0; index < 40; index++) {
    if (await control.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(control).toBeFocused();
}

async function openProposals(page: Page, source: string, replacement: string) {
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: {
        choices: [
          { message: { content: `<replacement>${replacement}</replacement>` }, finish_reason: "stop" },
        ],
      },
    }),
  );
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Manuscript fixture");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture-model");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Manuscript fixture" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
  const editor = page.getByRole("tabpanel").getByRole("textbox");
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Command Palette" }).pressSequentially("Ask AI");
  await page.keyboard.press("Enter");
  const assistant = page.getByRole("region", { name: "Ask AI", exact: true });
  await expect(assistant.getByRole("textbox", { name: "Instruction" })).toBeFocused();
  await page.keyboard.type("Revise the manuscript.");
  await page.keyboard.press("Enter");
  await expect(assistant.getByRole("button", { name: "Review proposed edits" })).toBeVisible();
  return { assistant, editor };
}

test("keyboard decisions advance through the manuscript and Escape restores the reading position", async ({
  page,
}) => {
  const tail = Array.from({ length: 65 }, (_, i) => `Background paragraph ${i + 1}.`).join("\n\n");
  const source = `# Methods\n\nOld opening.\n\nKeep these details.\n\nOld method.\n\n# Results\n\nOld result.\n\n${tail}\n\nReading anchor.`;
  const replacement = source
    .replace("Old opening.", "New opening.")
    .replace("Old method.", "New method.")
    .replace("Old result.", "New result.");
  const { assistant, editor } = await openProposals(page, source, replacement);
  await editor.press("ControlOrMeta+End");
  await expect.poll(() => page.evaluate(() => getSelection()?.focusNode?.textContent)).toBe("Reading anchor.");
  const top = await page.locator(".cm-scroller").evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await tabTo(page, assistant.getByRole("button", { name: "Review proposed edits" }));
  await page.keyboard.press("Enter");

  const review = page.getByRole("dialog", { name: "Review proposed edits" });
  const position = (text: string) => review.getByRole("heading", { name: text, exact: true });
  await expect(position("Replacement · Edit 1 of 3")).toBeFocused();
  await tabTo(page, review.getByRole("button", { name: "Dismiss proposed edit" }));
  await page.keyboard.press("Enter");
  await expect(position("Replacement · Edit 2 of 3")).toBeFocused();
  await tabTo(page, review.getByRole("button", { name: "Leave comment" }));
  await page.keyboard.press("Enter");
  await expect(review.getByRole("textbox", { name: "Review comment" })).toBeFocused();
  await page.keyboard.type("Check this with the research team.");
  await page.keyboard.press("Enter");
  await expect(position("Replacement · Edit 3 of 3")).toBeFocused();
  await tabTo(page, review.getByRole("button", { name: "Apply proposed edit" }));
  await page.keyboard.press("Enter");
  await expect(review.getByRole("heading", { name: "No edits match this view." })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect.poll(() => page.evaluate(() => getSelection()?.focusNode?.textContent)).toBe("Reading anchor.");
  await expect.poll(() => page.locator(".cm-scroller").evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source.replace("Old result.", "New result."));
});

test("table and formula edits keep their formatting in a stacked comparison with source available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 760 });
  const source = "# Results\n\n| Group | Count |\n| --- | --- |\n| Coast | 12 |\n\nTotals follow.\n\n$$\nx = 12\n$$";
  const replacement = source.replace("| Coast | 12 |", "| Coast | 17 |").replace("x = 12", "x = 17");
  const { assistant } = await openProposals(page, source, replacement);
  await tabTo(page, assistant.getByRole("button", { name: "Review proposed edits" }));
  await page.keyboard.press("Enter");

  const review = page.getByRole("dialog", { name: "Review proposed edits" });
  await expect(review.getByRole("heading", { name: "Table · Replacement · Edit 1 of 2" })).toBeFocused();
  const removed = review.getByRole("region", { name: "Removed text" });
  const added = review.getByRole("region", { name: "Added text" });
  await expect(removed.getByRole("cell", { name: "12", exact: true })).toBeVisible();
  await expect(added.getByRole("cell", { name: "17", exact: true })).toBeVisible();
  const before = await removed.boundingBox();
  const after = await added.boundingBox();
  expect(after?.y).toBeGreaterThan((before?.y ?? 0) + (before?.height ?? 0));

  const sourceToggle = review.getByRole("checkbox", { name: "Show Markdown source" });
  await tabTo(page, sourceToggle);
  await page.keyboard.press("Space");
  await expect(removed.getByText("| Coast | 12 |", { exact: true })).toBeVisible();
  await expect(added.getByText("| Coast | 17 |", { exact: true })).toBeVisible();
  await expect(review.getByRole("table")).toHaveCount(0);
  await page.keyboard.press("Space");

  await tabTo(page, review.getByRole("button", { name: "Next edit" }));
  await page.keyboard.press("Enter");
  await expect(review.getByRole("heading", { name: "Formula · Replacement · Edit 2 of 2" })).toBeFocused();
  await expect(removed.locator(".katex")).toBeVisible();
  await expect(added.locator(".katex")).toBeVisible();
  await tabTo(page, sourceToggle);
  await page.keyboard.press("Space");
  await expect(added.getByText("x = 17", { exact: true })).toBeVisible();
});

test("section acceptance preserves prior decisions and can be undone in one editor command", async ({
  page,
}) => {
  const source = "# Methods\n\nOld opening.\n\nOld detail.\n\nOld sample.\n\nOld measure.\n\n# Results\n\nOld result.";
  const replacement = source.replaceAll("Old ", "New ");
  const { assistant, editor } = await openProposals(page, source, replacement);
  await tabTo(page, assistant.getByRole("button", { name: "Review proposed edits" }));
  await page.keyboard.press("Enter");
  const review = page.getByRole("dialog", { name: "Review proposed edits" });
  const dismiss = review.getByRole("button", { name: "Dismiss proposed edit" });
  await tabTo(page, dismiss);
  await page.keyboard.press("Enter");
  await tabTo(page, review.getByRole("button", { name: "Leave comment" }));
  await page.keyboard.press("Enter");
  await page.keyboard.type("Confirm this detail.");
  await page.keyboard.press("Enter");

  const section = review.getByRole("combobox", { name: "Section" });
  await expect(section.getByRole("option", { name: "Methods · 2 pending of 4 edits" })).toHaveCount(1);
  await tabTo(page, section);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const accept = review.getByRole("button", { name: "Accept remaining edits in Methods" });
  await tabTo(page, accept);
  await page.keyboard.press("Enter");
  await expect(review.getByRole("heading", { name: "No edits match this view." })).toBeFocused();
  await expect(review.getByRole("status")).toHaveText("Accepted 2 edits.");

  const status = review.getByRole("combobox", { name: "Review status" });
  await tabTo(page, status);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(review.getByText("Proposed edit dismissed.")).toBeVisible();
  await expect(review.getByText("Old opening.", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(review.getByText("Confirm this detail.", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+S");
  const accepted = source.replace("Old sample.", "New sample.").replace("Old measure.", "New measure.");
  await expect.poll(() => readFile(page, path)).toBe(accepted);
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(source);

  await tabTo(page, page.getByRole("button", { name: "Resume conversation" }));
  await page.keyboard.press("Enter");
  await tabTo(page, assistant.getByRole("button", { name: "Review proposed edits" }));
  await page.keyboard.press("Enter");
  await expect(review.getByRole("heading", { name: "Replacement · Edit 3 of 5" })).toBeFocused();
});
