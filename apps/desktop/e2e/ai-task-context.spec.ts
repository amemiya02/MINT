import { expect, type Locator, test } from "@playwright/test";
import { launch } from "./memory-platform.ts";

const address = "https://materials.example.test/v1";
const endpoint = `${address}/chat/completions`;

async function dropInterview(target: Locator) {
  await target.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["Interview: the ridge reopened Tuesday.\n"], "interview.txt"));
    element.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
}

test("drop and paste two materials, check the send list, and edit the resulting untitled draft", async ({
  page,
}) => {
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: {
        choices: [
          { message: { content: "The ridge reopened on Tuesday." }, finish_reason: "stop" },
        ],
      },
    }),
  );
  await launch(page, { locale: "en-US" });
  await page.getByRole("button", { name: "Draft with AI" }).click();

  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("API address").fill(address);
  await composer.getByLabel("Model name").fill("fixture");
  await composer.getByLabel("Drafting instruction").fill("Draft a trail update.");
  const context = composer.getByRole("group", { name: "Task context to send" });
  await dropInterview(context);
  await context.getByText("Add files or paste text").click();
  await context.getByLabel("Pasted material").fill("Weather log: clear skies.");
  await context.getByRole("button", { name: "Add pasted text" }).click();

  await expect(context.getByText(endpoint, { exact: true })).toBeVisible();
  await expect(context.getByText("No selection")).toBeVisible();
  await expect(context.getByText("Empty untitled draft")).toBeVisible();
  await context.getByText("interview.txt", { exact: true }).click();
  await expect(context.getByText("Interview: the ridge reopened Tuesday.")).toBeVisible();
  await context.getByText("Pasted text", { exact: true }).click();
  await expect(context.getByText("Weather log: clear skies.", { exact: true })).toBeVisible();

  const [request] = await Promise.all([
    page.waitForRequest(endpoint),
    composer.getByRole("button", { name: "Generate draft" }).click(),
  ]);
  const user = request
    .postDataJSON()
    .messages.find(({ role }: { role: string }) => role === "user");
  expect(JSON.parse(user.content)).toEqual({
    instruction: expect.stringContaining("Draft a trail update."),
    taskContext: {
      materials: [
        { name: "interview.txt", text: "Interview: the ridge reopened Tuesday.\n" },
        { name: "Pasted text", text: "Weather log: clear skies." },
      ],
    },
  });

  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await expect(page.getByRole("tab", { name: "Untitled" })).toBeVisible();
  await expect(editor).toHaveText("The ridge reopened on Tuesday.");
  await page.keyboard.press("End");
  await page.keyboard.insertText(" Check the signage.");
  await expect(editor).toHaveText("The ridge reopened on Tuesday. Check the signage.");
});

for (const decision of ["allow", "skip"] as const) {
  test(`rewrite a selection and ${decision} a requested folder excerpt`, async ({ page }) => {
    const folder = "/trail";
    const draft = `${folder}/draft.md`;
    const selection = "The gate opens in the morning.";
    const instruction = "Rewrite this with the opening time, apply directly";
    const requests: unknown[] = [];
    await page.route(endpoint, (route) => {
      const content = route.request().postDataJSON().messages.at(-1).content;
      requests.push(JSON.parse(content));
      const reply =
        requests.length === 1
          ? JSON.stringify({
              requestMaterial: {
                name: "Operating hours",
                purpose: "Check the exact opening time.",
                query: "ridge gate",
              },
            })
          : decision === "allow"
            ? "<replacement>The ridge gate opens at 07:30.</replacement>"
            : "<replacement>The ridge gate opens each morning.</replacement>";
      return route.fulfill({
        json: { choices: [{ message: { content: reply }, finish_reason: "stop" }] },
      });
    });
    await launch(page, {
      locale: "en-US",
      files: {
        [draft]: `Trail notes.\n\n${selection}`,
        [`${folder}/gate-hours.md`]:
          "Internal contact: do not send.\nThe ridge gate opens at 07:30.\n",
        [`${folder}/private.md`]: "Private note about the ridge gate.",
        "/outside/gate.md": "Outside the folder: ridge gate.",
      },
      openedPaths: [
        { path: folder, kind: "directory" },
        { path: draft, kind: "file" },
      ],
    });
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Model connections" }).click();
    await settings.getByLabel("Connection name").fill("Trail model");
    await settings.getByLabel("API address").fill(address);
    await settings.getByLabel("Model name").fill("trail-fixture");
    await settings.getByRole("button", { name: "Use for this launch" }).click();
    await expect(settings.getByRole("region", { name: "Trail model" })).toBeVisible();
    await settings.getByRole("button", { name: "Close", exact: true }).click();

    const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
    await editor.getByText("Trail notes.", { exact: true }).click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" Author's unsaved addition.");
    await editor.getByText(selection, { exact: true }).click();
    await page.keyboard.press("End");
    for (const _ of selection) await page.keyboard.press("Shift+ArrowLeft");
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();

    const composer = page.getByRole("region", { name: "Ask AI" });
    const context = composer.getByRole("group", { name: "Task context to send" });
    await expect(context.getByText(selection, { exact: true })).toBeVisible();
    await expect(context.getByText(`Trail model · ${endpoint}`, { exact: true })).toBeVisible();
    await context.getByLabel("Include the full current draft").check();
    await expect(context.getByText(/Author's unsaved addition/)).toBeVisible();
    await dropInterview(context);
    await expect(context.getByText("interview.txt", { exact: true })).toBeVisible();
    const folderSearch = context.getByLabel("Allow searching the current working folder");
    await expect(folderSearch).not.toBeChecked();
    await folderSearch.check();
    await composer.getByRole("textbox", { name: "Instruction", exact: true }).fill(instruction);
    await composer.getByRole("button", { name: "Send", exact: true }).click();

    const approval = composer.getByRole("group", { name: "Additional material requested" });
    await expect(approval.getByText("Check the exact opening time.")).toBeVisible();
    const excerpt = approval.getByRole("radio", { name: "gate-hours.md · line 2" });
    await expect(excerpt).toBeVisible();
    await expect(approval.getByText("Outside the folder", { exact: false })).toHaveCount(0);
    await expect(approval.getByRole("button", { name: "Allow once" })).toBeDisabled();
    expect(requests).toHaveLength(1);
    const initial = {
      instruction,
      selectedText: selection,
      taskContext: {
        currentDraft: {
          name: "draft.md",
          text: `Trail notes. Author's unsaved addition.\n\n${selection}`,
        },
        materials: [{ name: "interview.txt", text: "Interview: the ridge reopened Tuesday.\n" }],
        folderSearch: true,
      },
    };
    expect(requests[0]).toEqual(initial);
    if (decision === "allow") {
      await excerpt.check();
      await approval.getByRole("button", { name: "Allow once" }).click();
    } else {
      await approval.getByRole("button", { name: "Skip" }).click();
    }
    await expect(editor).toContainText(
      decision === "allow"
        ? "The ridge gate opens at 07:30."
        : "The ridge gate opens each morning.",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      ...initial,
      taskContext: {
        ...initial.taskContext,
        materialDecisions: [
          {
            name: "Operating hours",
            purpose: "Check the exact opening time.",
            outcome: decision === "allow" ? "allowed" : "skipped",
            ...(decision === "allow"
              ? {
                  material: {
                    name: "gate-hours.md · line 2",
                    text: "The ridge gate opens at 07:30.",
                  },
                }
              : {}),
          },
        ],
      },
    });
  });
}
