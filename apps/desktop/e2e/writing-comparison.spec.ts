import { expect, test } from "@playwright/test";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

test("compare the same writing baseline, mix proposals, and continue with another connection", async ({
  page,
}) => {
  const path = "/notes/trail.md";
  const source = "**Old opening.**\r\n\r\nOld note.  \n\nOld ending.";
  const instruction = "Revise the opening and ending.";
  const first = "https://first.example.test/v1";
  const second = "https://second.example.test/v1";
  const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  for (const [address, reply] of [
    [first, "<replacement>**First opening.**\n\nOld note.  \n\nFirst ending.</replacement>"],
    [second, "<replacement>**Second opening.**\n\nOld note.  \n\nSecond ending.</replacement>"],
  ] as const) {
    await page.route(`${address}/chat/completions`, (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          choices: [
            {
              message: {
                content: requests.length === 3 ? "Continue the original discussion." : reply,
              },
              finish_reason: "stop",
            },
          ],
        },
      });
    });
  }
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, [settingsPath]: '{"autosave":false}' },
    openedPaths: [{ path, kind: "file" }],
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Model connections" }).click();
  for (const [name, address, model] of [
    ["First model", first, "first-fixture"],
    ["Second model", second, "second-fixture"],
  ] as const) {
    await settings.getByLabel("Connection name").fill(name);
    await settings.getByLabel("API address").fill(address);
    await settings.getByLabel("Model name").fill(model);
    await settings.getByRole("button", { name: "Use for this launch" }).click();
    await expect(settings.getByRole("region", { name })).toBeVisible();
  }
  await settings.getByRole("button", { name: "Close" }).click();

  const editor = page.locator(".cm-content");
  await editor.press("ControlOrMeta+A");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  const inline = page.getByRole("region", { name: "Ask AI" });
  await inline
    .getByLabel("Recipient")
    .selectOption({ label: `First model · ${first}/chat/completions` });
  const context = inline.getByRole("group", { name: "Task context to send" });
  await context.getByLabel("Include the full current draft").check();
  await context.getByText("Add files or paste text").click();
  await context.getByLabel("Pasted material").fill("Field notes from Tuesday.");
  await context.getByRole("button", { name: "Add pasted text" }).click();
  await inline.getByRole("textbox", { name: "Instruction" }).fill(instruction);
  await inline.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await inline.getByRole("button", { name: "Continue in sidebar" }).click();
  const sidebar = page.getByRole("complementary", { name: "Writing Assistant" });

  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nLater author notes.");
  await sidebar.getByRole("button", { name: "Retry same baseline" }).click();
  const approval = sidebar.getByRole("group", { name: "Retry same baseline" });
  await approval
    .getByLabel("Retry connection")
    .selectOption({ label: `Second model · ${second}/chat/completions` });
  await expect(approval).toContainText(instruction);
  await expect(approval).toContainText("Pasted text");
  await expect(approval).toContainText("trail.md");
  expect(requests).toHaveLength(1);
  await approval
    .getByRole("button", {
      name: `Send same baseline to Second model · ${second}/chat/completions`,
    })
    .click();

  const comparison = page.getByRole("dialog", { name: "Compare writing alternatives" });
  const original = comparison.getByRole("region", { name: "Original proposal" });
  const alternate = comparison.getByRole("region", { name: "Alternative proposal" });
  const opening = original.getByRole("group", { name: "Proposed edit 1 of 2" });
  const ending = alternate.getByRole("group", { name: "Proposed edit 2 of 2" });
  await expect(opening.getByText("First opening.", { exact: true })).toBeVisible();
  await expect(ending.getByText("Second ending.", { exact: true })).toBeVisible();
  expect(requests.map(({ model }) => model)).toEqual(["first-fixture", "second-fixture"]);
  expect(requests[1]?.messages).toEqual(requests[0]?.messages);
  const sent = JSON.parse(requests[0]?.messages.at(-1)?.content ?? "");
  expect(sent).toEqual({
    instruction,
    selectedText: source,
    taskContext: {
      currentDraft: { name: "trail.md", text: source },
      materials: [{ name: "Pasted text", text: "Field notes from Tuesday." }],
    },
  });
  expect(await readFile(page, path)).toBe(source);

  await opening.getByRole("button", { name: "Apply proposed edit" }).click();
  await ending.getByRole("button", { name: "Apply proposed edit" }).click();
  await expect(original.getByText("First ending.", { exact: true })).toBeVisible();
  await expect(alternate.getByText("Second opening.", { exact: true })).toBeVisible();
  await comparison.getByRole("button", { name: "Close", exact: true }).click();
  await editor.press("ControlOrMeta+S");
  await expect
    .poll(() => readFile(page, path))
    .toBe("**First opening.**\r\n\r\nOld note.  \n\nSecond ending.\r\n\r\nLater author notes.");

  await sidebar
    .getByLabel("Recipient")
    .selectOption({ label: `Second model · ${second}/chat/completions` });
  await sidebar.getByLabel("Send earlier instructions and replies with this message").check();
  await expect(sidebar.getByRole("button", { name: "Compare proposals" })).toBeVisible();
  expect(requests).toHaveLength(2);
  await sidebar.getByRole("textbox", { name: "Instruction" }).fill("Continue the discussion.");
  await sidebar.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect(
    sidebar.getByText("Continue the original discussion.", { exact: true }),
  ).toBeVisible();
  expect(requests[2]?.model).toBe("second-fixture");
  expect(requests[2]?.messages.filter(({ role }) => role === "assistant")).toEqual([
    { role: "assistant", content: "**First opening.**\n\nOld note.  \n\nFirst ending." },
  ]);
});
