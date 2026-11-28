import { expect, type Page, test } from "@playwright/test";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

const origin = "/notes/origin.md";
const other = "/notes/other.md";
const endpoint = "https://navigation.example.test/v1/chat/completions";
const original = "It was a very slow start.";

async function openWritingFixture(page: Page) {
  await launch(page, {
    locale: "en-US",
    files: {
      [origin]: original,
      [other]: "Other manuscript.",
      [settingsPath]: '{"autosave":false}',
    },
    openedPaths: [{ path: origin, kind: "file" }],
    openDialogResults: [other],
    openFolderDialogResults: ["/notes"],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  await settings.getByLabel("Connection name").fill("Task navigation fixture");
  await settings.getByLabel("API address").fill(endpoint);
  await settings.getByLabel("Model name").fill("fixture-writer");
  await settings.getByRole("button", { name: "Use for this launch" }).click();
  await expect(settings.getByRole("region", { name: "Task navigation fixture" })).toBeVisible();
  await settings.getByRole("button", { name: "Close" }).click();
}

async function openSelectionTask(page: Page) {
  const editor = page.getByRole("tabpanel", { name: "origin.md" }).locator(".cm-content");
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  return page.getByRole("region", { name: "Ask AI" });
}

test("Writing tasks defaults to the current document and All writing tasks reopens a closed draft's result", async ({
  page,
}) => {
  const title = "Tighten the first sentence";
  const requests: unknown[] = [];
  await page.route(endpoint, (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        choices: [{ message: { content: "<replacement>It was a slow start.</replacement>" } }],
      },
    });
  });
  await openWritingFixture(page);
  const inline = await openSelectionTask(page);
  await inline.getByRole("textbox", { name: "Instruction" }).fill(title);
  await inline.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect(inline.getByRole("button", { name: "Apply proposed edit" })).toBeVisible();

  await runMenuItem(page, "tab.close");
  await expect(page.getByRole("tab", { name: "origin.md" })).toHaveCount(0);
  await runMenuItem(page, "file.open");
  await expect(page.getByRole("tab", { name: "other.md" })).toBeVisible();
  await runMenuItem(page, "edit.writingTasks");
  const tasks = page.getByRole("dialog", { name: "Writing tasks" });
  await expect(tasks.getByText("No saved writing tasks for this document.")).toBeVisible();

  await tasks.getByRole("button", { name: "All writing tasks", exact: true }).click();
  const all = page.getByRole("dialog", { name: "All writing tasks" });
  const result = all.getByRole("listitem").filter({ hasText: title });
  await expect(result).toContainText("origin.md");
  await expect(result).toContainText("Complete");
  await expect(result).toContainText("1 decision needed");
  await result.getByRole("button", { name: title, exact: true }).click();

  const assistant = page.getByRole("complementary", { name: "Writing Assistant" });
  await expect(page.getByRole("tab", { name: "origin.md", selected: true })).toBeVisible();
  await expect(
    assistant.getByRole("button", { name: "Apply proposed edit", exact: true }),
  ).toBeVisible();
  expect(await readFile(page, origin)).toBe(original);
  expect(requests).toHaveLength(1);
});

test("a cross-document inquiry belongs to its working folder and resumes its result", async ({
  page,
}) => {
  const title = "Find the related passage in these manuscripts";
  const answer = "The related passage is in the other manuscript.";
  const requests: string[] = [];
  await page.route(endpoint, (route) => {
    const body = route.request().postDataJSON();
    requests.push(body.messages.at(-1).content);
    const content =
      requests.length === 1
        ? JSON.stringify({
            requestMaterial: {
              name: "Related passage",
              purpose: "Find the related passage in the working folder.",
              query: "Other manuscript",
            },
          })
        : answer;
    return route.fulfill({ json: { choices: [{ message: { content } }] } });
  });
  await openWritingFixture(page);
  await runMenuItem(page, "file.openFolder");
  await expect(page.getByText("other.md", { exact: true })).toBeVisible();
  await runMenuItem(page, "edit.askFolderAI");

  const assistant = page.getByRole("complementary", { name: "Writing Assistant" });
  await assistant.getByRole("textbox", { name: "Instruction" }).fill(title);
  await assistant.getByLabel("Allow searching the current working folder").check();
  await assistant.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await assistant.getByRole("radio", { name: /other\.md/ }).check();
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0] ?? "")).toEqual({
    instruction: title,
    taskContext: { folderSearch: true },
  });
  await assistant.getByRole("button", { name: "Allow once" }).click();
  await expect(assistant.getByRole("textbox", { name: "AI reply", exact: true })).toHaveValue(
    answer,
  );
  expect(requests[1]).toContain("Other manuscript.");

  await assistant.getByRole("button", { name: "Writing tasks", exact: true }).click();
  const current = page.getByRole("dialog", { name: "Writing tasks" });
  await expect(current.getByText("No saved writing tasks for this document.")).toBeVisible();
  await current.getByRole("button", { name: "Close" }).click();

  await runMenuItem(page, "tab.close");
  await expect(page.getByRole("tab", { name: "origin.md" })).toHaveCount(0);
  await runMenuItem(page, "edit.allWritingTasks");
  const all = page.getByRole("dialog", { name: "All writing tasks" });
  const row = all.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText("Working folder · /notes");
  await row.getByRole("button", { name: title, exact: true }).click();
  await expect(assistant.getByRole("textbox", { name: "AI reply", exact: true })).toHaveValue(
    answer,
  );
  expect(requests).toHaveLength(2);
});

test("background decisions announce once and completion leaves the other editor focused", async ({
  page,
}) => {
  const title = "Tighten the opening with supporting notes";
  const fulfilled: ((content: string) => void)[] = [];
  await page.route(endpoint, async (route) => {
    const text = await new Promise<string>((resolve) => fulfilled.push(resolve));
    await route.fulfill({ json: { choices: [{ message: { content: text } }] } });
  });
  await openWritingFixture(page);
  const inline = await openSelectionTask(page);
  await inline.getByRole("textbox", { name: "Instruction" }).fill(title);
  await inline.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect.poll(() => fulfilled.length).toBe(1);
  await runMenuItem(page, "file.open");
  const otherEditor = page.getByRole("tabpanel", { name: "other.md" }).locator(".cm-content");
  await expect(otherEditor).toBeFocused();
  fulfilled[0]?.(
    JSON.stringify({
      requestMaterial: { name: "Source note", purpose: "Check wording against the note." },
    }),
  );

  const notifications = page.getByRole("region", { name: "Writing task notifications" });
  await expect(notifications).toContainText("Waiting for approval");
  await expect(notifications).toContainText("Source note");
  await expect(otherEditor).toBeFocused();
  await notifications.getByRole("button", { name: "Dismiss notification" }).click();
  await page.getByRole("tab", { name: "origin.md" }).click();
  await page.getByRole("tab", { name: "other.md" }).click();
  await expect(notifications).not.toContainText("Source note");

  await runMenuItem(page, "edit.allWritingTasks");
  const all = page.getByRole("dialog", { name: "All writing tasks" });
  const row = all.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText("Waiting for approval");
  await expect(row).toContainText("1 decision needed");
  await row.getByRole("button", { name: title, exact: true }).click();
  const assistant = page.getByRole("complementary", { name: "Writing Assistant" });
  await assistant.getByRole("button", { name: "Skip" }).click();
  await expect.poll(() => fulfilled.length).toBe(2);
  await page.getByRole("tab", { name: "other.md" }).click();
  await expect(otherEditor).toBeFocused();
  fulfilled[1]?.("<replacement>It was a slow start.</replacement>");

  await expect(notifications).toContainText("Complete");
  await expect(notifications).toContainText("1 decision needed");
  await expect(otherEditor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" Still writing.");
  await expect(otherEditor).toHaveText("Other manuscript. Still writing.");
  await notifications.getByRole("button", { name: "Open task for origin.md" }).click();
  await expect(page.getByRole("tab", { name: "origin.md", selected: true })).toBeVisible();
  await expect(
    assistant.getByRole("button", { name: "Apply proposed edit", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "other.md" }).click();
  await expect(notifications).not.toContainText("Complete");
  expect(await readFile(page, origin)).toBe(original);
});
