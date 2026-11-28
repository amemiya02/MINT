import { expect, type Page, test } from "@playwright/test";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

const address = "https://review.example.test/v1";
const endpoint = `${address}/chat/completions`;
const path = "/notes/review.md";
const original = "﻿First passage.\r\nSecond passage.  \nThird passage.\r\nPrivate appendix.\n";

async function openReviewDraft(page: Page) {
  await launch(page, {
    files: { [path]: original, [settingsPath]: '{"autosave":false}' },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Review fixture");
  await settings.getByLabel("API address").fill(address);
  await settings.getByLabel("Model name").fill("fixture-reviewer");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  return page.getByRole("tabpanel").getByRole("textbox");
}

async function annotateLine(page: Page, line: number, note: string) {
  await page.getByRole("tabpanel").getByRole("textbox").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let index = 0; index < line; index++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+End");
  await runMenuItem(page, "edit.addAnnotation");
  await page.getByRole("textbox", { name: "Annotation" }).fill(note);
  await page.getByRole("button", { name: "Save annotation" }).click();
}

test("review annotations in manuscript order and resolve a reply by hand", async ({ page }) => {
  const editor = await openReviewDraft(page);
  await annotateLine(page, 2, "Is the third passage clear?");
  await annotateLine(page, 0, "Shorten the opening.");
  await annotateLine(page, 3, "Keep this private.");
  const panel = page.getByRole("complementary", { name: "Annotations" });
  await panel.getByRole("checkbox", { name: "Select annotation Keep this private." }).uncheck();
  await panel.getByRole("button", { name: "Send annotations for review" }).click();

  let sent: unknown;
  await page.route(endpoint, async (route) => {
    const messages = route.request().postDataJSON().messages;
    const body = JSON.parse(messages.at(-1).content);
    sent = body;
    const [first, third] = body.annotationBatch;
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: [
                  { id: third.id, reply: "The third passage is clear." },
                  { id: first.id, replacement: "Opening." },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    });
  });
  await panel
    .getByRole("button", { name: /Preview first · 2 annotations · Review fixture/ })
    .click();
  const results = panel.getByRole("region", { name: "Annotation review results" });
  const items = results.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("Shorten the opening.");
  await expect(items.last()).toContainText("The third passage is clear.");
  await expect(editor).toContainText("First passage.");
  expect(sent).toMatchObject({
    annotationBatch: [
      { kind: "text", excerpt: "First passage.", note: "Shorten the opening." },
      { kind: "text", excerpt: "Third passage.", note: "Is the third passage clear?" },
    ],
  });
  expect(JSON.stringify(sent)).not.toContain("Private appendix");
  await items.last().getByRole("button", { name: "Mark resolved" }).click();
  await expect(panel.getByRole("region", { name: "Resolved", exact: true })).toContainText(
    "Is the third passage clear?",
  );
  await items.first().getByRole("button", { name: "Apply proposed edit" }).click();
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe(original.replace("First passage.", "Opening."));
});

test("direct review applies independent edits and lists missing material and conflicts", async ({
  page,
}) => {
  const editor = await openReviewDraft(page);
  await annotateLine(page, 0, "Shorten the opening.");
  await annotateLine(page, 1, "Check the source.");
  await annotateLine(page, 2, "Simplify this.");
  let respond!: () => void;
  const waitForAuthor = new Promise<void>((resolve) => {
    respond = resolve;
  });
  await page.route(endpoint, async (route) => {
    const [first, second, third] = JSON.parse(
      route.request().postDataJSON().messages.at(-1).content,
    ).annotationBatch;
    await waitForAuthor;
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                results: [
                  { id: second.id, missingMaterial: "The interview transcript." },
                  { id: third.id, replacement: "Third." },
                  { id: first.id, replacement: "Opening." },
                ],
              }),
            },
          },
        ],
      },
    });
  });
  const panel = page.getByRole("complementary", { name: "Annotations" });
  await panel.getByRole("button", { name: "Send annotations for review" }).click();
  const action = panel.getByRole("combobox", { name: "Action", exact: true });
  await expect(action).toBeVisible({ timeout: 3000 });
  await action.selectOption({ label: "Apply directly" });
  await Promise.all([
    page.waitForRequest(endpoint),
    panel.getByRole("button", { name: /Apply directly · 3 annotations · Review fixture/ }).click(),
  ]);
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("author's ");
  respond();

  const results = panel.getByRole("region", { name: "Annotation review results" });
  await expect(results).toContainText("1 edit applied");
  await expect(results).toContainText("Material needed · The interview transcript.");
  await expect(results).toContainText("The original boundaries changed");
  await expect(editor).toContainText("Opening.");
  await expect(editor).toContainText("Tauthor's hird passage.");
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+S");
  const handEdit = original.replace("Third", "Tauthor's hird");
  await expect
    .poll(() => readFile(page, path))
    .toBe(handEdit.replace("First passage.", "Opening."));
  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(handEdit);
});

test("read-only document review annotates the live draft without editing it", async ({ page }) => {
  const editor = await openReviewDraft(page);
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type("Live opening. ");
  const liveDraft = original.replace("First", "Live opening. First");
  let sent: unknown;
  await page.route(endpoint, async (route) => {
    sent = JSON.parse(route.request().postDataJSON().messages.at(-1).content);
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    quote: "Live opening.",
                    note: "Explain what this introduces.",
                    replacement: "Unapproved edit.",
                  },
                ],
                results: [{ replacement: "Unapproved rewrite." }],
              }),
            },
          },
        ],
      },
    });
  });

  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("combobox", { name: "Command Palette" });
  await palette.fill("Review document");
  await expect(
    page.getByRole("option", { name: "Review Document (Read Only)…", exact: true }),
  ).toBeVisible({ timeout: 3000 });
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Annotations" });
  const plan = panel.getByRole("group", { name: "Task call plan" });
  await expect(plan).toContainText(
    `${Buffer.byteLength(liveDraft.slice(1))} UTF-8 bytes of material`,
  );
  await expect(plan).toContainText("1 planned writing call");
  await plan.getByLabel("Task call limit").fill("1");
  expect(sent).toBeUndefined();
  await panel
    .getByRole("button", { name: /Comment only · Current document · Review fixture/ })
    .click();
  const note = panel.getByRole("region", { name: "Pending" }).getByRole("listitem").filter({
    hasText: "Explain what this introduces.",
  });
  await expect(note.getByRole("blockquote")).toHaveText("Live opening.");
  expect(sent).toMatchObject({ selectedText: liveDraft.slice(1) });
  expect(await readFile(page, path)).toBe(original);
  await note.getByRole("button", { name: "Go to target" }).click();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("Live opening.");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, path)).toBe(liveDraft);
});
