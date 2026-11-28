import { expect, test } from "@playwright/test";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import { launch, readFile, runMenuItem, settingsPath } from "./memory-platform.ts";

test("compare the same writing baseline, mix proposals, and continue with another connection", async ({
  browser,
  page,
}) => {
  const path = "/notes/trail.md";
  const source = "**Old opening.**\r\n\r\nOld note.  \n\nOld ending.";
  const instruction = "Revise the opening and ending.";
  const requestMaterial = { name: "Trail notes", purpose: "Confirm the opening." };
  const extraMaterial = "The ridge reopened Tuesday.";
  const first = "https://first.example.test/v1";
  const second = "https://second.example.test/v1";
  const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  for (const [address, reply] of [
    [first, "<replacement>**First opening.**\n\nOld note.  \n\nFirst ending.</replacement>"],
    [second, "<replacement>**Second opening.**\n\nOld note.  \n\nSecond ending.</replacement>"],
  ] as const) {
    await page.route(`${address}/chat/completions`, (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 3) return route.fulfill({ status: 503 });
      const content =
        requests.length === 1
          ? JSON.stringify({ requestMaterial })
          : requests.length === 5
            ? "Continue the original discussion."
            : reply;
      return route.fulfill({
        json: {
          choices: [{ message: { content }, finish_reason: "stop" }],
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
  const requested = inline.getByRole("group", { name: "Additional material requested" });
  await requested.getByText("Add files or paste text").click();
  await requested.getByLabel("Pasted material").fill(extraMaterial);
  await requested.getByRole("button", { name: "Add pasted text" }).click();
  await requested.getByRole("radio", { name: "Pasted text" }).check();
  await requested.getByRole("button", { name: "Allow once" }).click();
  await inline.getByRole("button", { name: "Continue in sidebar" }).click();
  const sidebar = page.getByRole("complementary", { name: "Writing Assistant" });

  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\nLater author notes.");
  await sidebar.getByRole("button", { name: "Retry same baseline" }).click();
  const approval = sidebar.getByRole("group", { name: "Retry same baseline" });
  const secondLabel = `Second model · ${second}/chat/completions`;
  await approval.getByLabel("Retry connection").selectOption({ label: secondLabel });
  await expect(approval).toContainText(instruction);
  await expect(approval).toContainText("Pasted text");
  await expect(approval).toContainText("trail.md");
  await approval.getByText("Pasted text", { exact: true }).last().click();
  await expect(approval.getByText(extraMaterial, { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  const sendBaseline = approval.getByRole("button", {
    name: `Send same baseline to ${secondLabel}`,
  });
  await sendBaseline.click();
  await expect(
    sidebar.getByRole("button", { name: "Retry generation", exact: true }),
  ).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Retry with selected connection" })).toHaveCount(
    0,
  );
  await sidebar.getByRole("button", { name: "Retry same baseline" }).click();
  await approval.getByLabel("Retry connection").selectOption({ label: secondLabel });
  expect(requests).toHaveLength(3);
  await sendBaseline.click();

  const comparison = page.getByRole("dialog", { name: "Compare writing alternatives" });
  const original = comparison.getByRole("region", { name: "Original proposal" });
  const alternate = comparison.getByRole("region", { name: "Alternative proposal" });
  const opening = original.getByRole("group", { name: "Proposed edit 1 of 2" });
  const ending = alternate.getByRole("group", { name: "Proposed edit 2 of 2" });
  await expect(opening.getByText("First opening.", { exact: true })).toBeVisible();
  await expect(ending.getByText("Second ending.", { exact: true })).toBeVisible();
  const left = await original.boundingBox();
  const right = await alternate.boundingBox();
  expect(left?.y).toBe(right?.y);
  expect(left && right && right.x >= left.x + left.width).toBe(true);
  expect(requests.map(({ model }) => model)).toEqual([
    "first-fixture",
    "first-fixture",
    "second-fixture",
    "second-fixture",
  ]);
  expect(requests[2]?.messages).toEqual(requests[1]?.messages);
  expect(requests[3]?.messages).toEqual(requests[1]?.messages);
  const sent = JSON.parse(requests[3]?.messages.at(-1)?.content ?? "");
  expect(sent).toEqual({
    instruction,
    selectedText: source,
    taskContext: {
      currentDraft: { name: "trail.md", text: source },
      materials: [{ name: "Pasted text", text: "Field notes from Tuesday." }],
      materialDecisions: [
        {
          ...requestMaterial,
          outcome: "allowed",
          material: { name: "Pasted text", text: extraMaterial },
        },
      ],
    },
  });
  expect(await readFile(page, path)).toBe(source);

  await opening.getByRole("button", { name: "Apply proposed edit" }).click();
  await ending.getByRole("button", { name: "Apply proposed edit" }).click();
  await expect(original.getByText("First ending.", { exact: true })).toBeVisible();
  await expect(alternate.getByText("Second opening.", { exact: true })).toBeVisible();
  await comparison.getByRole("button", { name: "Close", exact: true }).click();
  await editor.press("ControlOrMeta+S");
  const mixed =
    "**First opening.**\r\n\r\nOld note.  \n\nSecond ending.\r\n\r\nLater author notes.";
  await expect.poll(() => readFile(page, path)).toBe(mixed);

  await sidebar.getByLabel("Recipient for next message").selectOption({ label: secondLabel });
  await sidebar.getByLabel("Send earlier instructions and replies with this message").check();
  await expect(sidebar.getByRole("button", { name: "Compare proposals" })).toBeVisible();
  expect(requests).toHaveLength(4);
  await sidebar.getByRole("textbox", { name: "Instruction" }).fill("Continue the discussion.");
  await sidebar.getByRole("textbox", { name: "Instruction" }).press("Enter");
  await expect(
    sidebar.getByText("Continue the original discussion.", { exact: true }),
  ).toBeVisible();
  expect(requests[4]?.model).toBe("second-fixture");
  expect(requests[4]?.messages.filter(({ role }) => role === "assistant")).toEqual([
    { role: "assistant", content: "**First opening.**\n\nOld note.  \n\nFirst ending." },
  ]);

  const appData = await page.evaluate(() => {
    const platform = (window as unknown as { __MINT_MEMORY_PLATFORM__: MemoryPlatform })
      .__MINT_MEMORY_PLATFORM__;
    return Object.fromEntries(platform.appData);
  });
  const reopened = await browser.newContext();
  try {
    const resumed = await reopened.newPage();
    await resumed.route(/https:\/\/(first|second)\.example\.test\//, (route) => {
      requests.push(route.request().postDataJSON());
      return route.abort();
    });
    await launch(resumed, {
      locale: "en-US",
      appData,
      files: { [path]: mixed },
      openedPaths: [{ path, kind: "file" }],
    });
    await runMenuItem(resumed, "edit.writingTasks");
    await resumed.getByRole("button", { name: instruction, exact: true }).click();
    await resumed.getByRole("button", { name: "Compare proposals" }).click();
    const restored = resumed.getByRole("dialog", { name: "Compare writing alternatives" });
    await expect(restored.getByRole("region", { name: "Original proposal" })).toContainText(
      "First ending.",
    );
    await expect(restored.getByRole("region", { name: "Alternative proposal" })).toContainText(
      "Second opening.",
    );
    expect(requests).toHaveLength(5);
  } finally {
    await reopened.close();
  }
});
