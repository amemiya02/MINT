import { expect, test } from "@playwright/test";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import { externalWrite, launch, readFile, runMenuItem } from "./memory-platform.ts";

test("a material-based draft keeps its original excerpts when a source is revised after restart", async ({
  page,
  browser,
}) => {
  const address = "https://sources.example.test/v1";
  const instruction = "Draft a short bulletin from the two field records.";
  const supported = "The north ridge reopened Tuesday.";
  const alsoAffected = "Hikers can enter from the north.";
  const unchanged = "The south trail is still closed.";
  const unsupported = "The south trail reopened too.";
  const unlisted = "There were no delays.";
  const generated = `${supported} ${alsoAffected} ${unchanged} ${unsupported} ${unlisted}`;
  const excerpt = "Crews reopened the north ridge on Tuesday.";
  const otherExcerpt = "The south trail is still closed.";
  const reply = `${generated}\n\n<source-passages>\n${JSON.stringify([
    { claim: supported, material: 1, quote: excerpt },
    { claim: alsoAffected, material: 1, quote: excerpt },
    { claim: unchanged, material: 2, quote: otherExcerpt },
    { claim: unsupported, material: 1, quote: otherExcerpt },
  ])}\n</source-passages>`;
  const endpoint = `${address}/chat/completions`;
  const draftPath = "/notes/bulletin.md";
  const exportPath = "/notes/bulletin.html";
  let sends = 0;
  await page.route(endpoint, (route) => {
    sends++;
    return route.fulfill({
      json: { choices: [{ message: { content: reply }, finish_reason: "stop" }] },
    });
  });
  await launch(page, {
    locale: "en-US",
    directories: ["/notes"],
    saveDialogResults: [draftPath, exportPath],
  });
  await page.getByRole("button", { name: "Draft with AI" }).click();
  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("API address").fill(address);
  await composer.getByLabel("Model name").fill("fixture-model");
  await composer.getByLabel("Drafting instruction").fill(instruction);
  await composer.getByRole("group", { name: "Task context to send" }).evaluate(
    (target, files) => {
      const dataTransfer = new DataTransfer();
      for (const { name, text } of files) dataTransfer.items.add(new File([text], name));
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
      );
    },
    [
      { name: "ridge.md", text: `# Trail log\n${excerpt}\n` },
      { name: "south.md", text: `${otherExcerpt}\n` },
    ],
  );
  await expect(composer.getByText("south.md", { exact: true })).toBeVisible();
  const [sent] = await Promise.all([
    page.waitForRequest(endpoint),
    composer.getByRole("button", { name: "Generate draft" }).click(),
  ]);
  const request = JSON.parse(sent.postDataJSON().messages.at(-1).content);
  expect(request.taskContext.materials).toEqual([
    { name: "ridge.md", text: `# Trail log\n${excerpt}\n` },
    { name: "south.md", text: `${otherExcerpt}\n` },
  ]);

  const editor = page.getByRole("tabpanel").getByRole("textbox", { name: "", exact: true });
  await expect(editor).toHaveText(generated);
  const review = page.getByRole("region", { name: "Source passages" });
  await review.getByRole("button", { name: supported, exact: true }).click();
  const passage = review.getByRole("region", { name: "Excerpt used for this draft" });
  await expect(passage).toContainText("ridge.md");
  await expect(passage).toContainText("Line 2 of sent material");
  await expect(passage.getByText(excerpt, { exact: true })).toBeVisible();
  await expect(review.getByRole("listitem").filter({ hasText: unsupported })).toContainText(
    "Needs verification",
  );
  await expect(review.getByRole("listitem").filter({ hasText: unlisted })).toContainText(
    "Needs verification",
  );

  await runMenuItem(page, "file.save");
  await expect.poll(() => readFile(page, draftPath)).toBe(generated);
  await runMenuItem(page, "file.exportHtml");
  await page
    .getByRole("dialog", { name: "Export as HTML" })
    .getByRole("button", { name: "Export" })
    .click();
  await expect.poll(() => readFile(page, exportPath)).toContain(`<p>${generated}</p>`);
  const html = await readFile(page, exportPath);
  expect(html).not.toMatch(/Needs verification|source-passages|Crews reopened/);

  await runMenuItem(page, "tab.close");
  const appData = await page.evaluate(() => {
    const { __MINT_MEMORY_PLATFORM__: platform } = window as unknown as {
      __MINT_MEMORY_PLATFORM__: MemoryPlatform;
    };
    return Object.fromEntries(platform.appData);
  });
  const revised = "The ridge will stay closed through Friday.";
  const revisedPath = "/notes/ridge.md";
  const rebooted = await browser.newContext();
  try {
    const checks: unknown[] = [];
    await rebooted.route(endpoint, (route) => {
      sends++;
      const request = JSON.parse(route.request().postDataJSON().messages.at(-1).content);
      checks.push(JSON.parse(request.selectedText));
      const content = JSON.stringify([
        { id: 1, assessment: "The revised log contradicts the reopening date." },
        { id: 2, assessment: "The revised log no longer supports north access." },
      ]);
      return route.fulfill({
        json: { choices: [{ message: { content }, finish_reason: "stop" }] },
      });
    });
    const reopened = await rebooted.newPage();
    await launch(reopened, {
      locale: "en-US",
      appData,
      files: {
        [draftPath]: generated,
        [revisedPath]: `# Revised edition\n# Trail log\n${revised}\n`,
      },
      fileDialogResults: [revisedPath],
    });
    await reopened.evaluate(async (address) => {
      const { __MINT_MEMORY_PLATFORM__: platform } = window as unknown as {
        __MINT_MEMORY_PLATFORM__: MemoryPlatform;
      };
      await platform.saveModelConnection({
        name: "Verification model",
        address,
        model: "fixture-model",
        apiKey: "",
        lifetime: "session",
      });
    }, address);
    await runMenuItem(reopened, "edit.allWritingTasks");
    await reopened
      .getByRole("dialog", { name: "All writing tasks" })
      .getByRole("button", { name: instruction, exact: true })
      .click();
    const restored = reopened.getByRole("region", { name: "Source passages" });
    await restored.getByRole("button", { name: supported, exact: true }).click();
    const original = restored.getByRole("region", { name: "Excerpt used for this draft" });
    await expect(original.getByText(excerpt, { exact: true })).toBeVisible();
    await expect(original).toContainText("ridge.md");
    const chooseRevision = original.getByRole("button", { name: "Choose revised source" });
    await expect(chooseRevision).toBeVisible();
    await chooseRevision.click();
    await expect(restored.getByRole("region", { name: "Source comparison" })).toContainText(
      revised,
    );
    await expect(original.getByText(excerpt, { exact: true })).toBeVisible();
    expect(sends).toBe(1);
    expect(await readFile(reopened, draftPath)).toBe(generated);
    const verification = restored.getByRole("region", { name: "Affected statements" });
    await expect(verification).toBeVisible();
    await verification.getByLabel("Verification recipient").selectOption({
      label: `Verification model · ${endpoint}`,
    });
    await verification.getByRole("button", { name: "Verify affected statements" }).click();
    await expect(verification).toContainText("The revised log contradicts the reopening date.");
    await expect(verification).toContainText("The revised log no longer supports north access.");
    await expect(verification).not.toContainText(unchanged);
    expect(checks).toEqual([
      [
        { id: 1, claim: supported, evidence: [{ source: "ridge.md", original: excerpt, revised }] },
        {
          id: 2,
          claim: alsoAffected,
          evidence: [{ source: "ridge.md", original: excerpt, revised }],
        },
      ],
    ]);
    expect(await readFile(reopened, draftPath)).toBe(generated);
    await original.getByRole("button", { name: "Cite the original excerpt in Markdown" }).click();
    await runMenuItem(reopened, "file.save");
    await expect
      .poll(() => readFile(reopened, draftPath))
      .toBe(
        `${supported}[^mint-source-1]${generated.slice(supported.length)}\n\n[^mint-source-1]: ridge.md, line 2 of sent material. “${excerpt}”\n`,
      );
    expect(sends).toBe(2);
  } finally {
    await rebooted.close();
  }
});

test("a working-folder source can be reread locally without sending another request", async ({
  page,
}) => {
  const address = "https://folder-sources.example.test/v1";
  const source = "/notes/ridge.md";
  const original = "The north ridge reopened Tuesday.";
  const revised = "The north ridge stayed closed.";
  const requests: unknown[] = [];
  await page.route(`${address}/chat/completions`, (route) => {
    requests.push(JSON.parse(route.request().postDataJSON().messages.at(-1).content));
    const content =
      requests.length === 1
        ? JSON.stringify({
            requestMaterial: { name: "Ridge log", purpose: "Check access.", query: "north ridge" },
          })
        : `${original}\n\n<source-passages>\n${JSON.stringify([
            { claim: original, material: 1, quote: original },
          ])}\n</source-passages>`;
    return route.fulfill({ json: { choices: [{ message: { content }, finish_reason: "stop" }] } });
  });
  await launch(page, {
    locale: "en-US",
    openedPaths: [{ path: "/notes", kind: "directory" }],
    files: { [source]: `Private notes.\n${original}\n` },
  });
  await runMenuItem(page, "file.draftWithAi");
  const composer = page.getByRole("form", { name: "Draft with AI" });
  await composer.getByLabel("API address").fill(address);
  await composer.getByLabel("Model name").fill("fixture-model");
  await composer.getByLabel("Drafting instruction").fill("Draft one statement about the ridge.");
  await composer.getByLabel("Allow searching the current working folder").check();
  await composer.getByRole("button", { name: "Generate draft" }).click();
  const approval = composer.getByRole("group", { name: "Additional material requested" });
  const label = "ridge.md · line 2";
  await approval.getByRole("radio", { name: label }).check();
  await approval.getByRole("button", { name: "Allow once" }).click();
  const review = page.getByRole("region", { name: "Source passages" });
  await review.getByRole("button", { name: original, exact: true }).click();
  expect(requests[1]).toMatchObject({
    taskContext: {
      materialDecisions: [
        {
          name: "Ridge log",
          purpose: "Check access.",
          outcome: "allowed",
          material: { name: label, text: original },
        },
      ],
    },
  });
  expect(JSON.stringify(requests)).not.toMatch(/\/notes|Private notes/);
  await externalWrite(page, source, `Private notes.\n${revised}\n`);
  const readCurrent = review.getByRole("button", { name: "Read current source" });
  await expect(readCurrent).toBeVisible();
  await readCurrent.click();
  await expect(review.getByRole("region", { name: "Source comparison" })).toContainText(revised);
  await expect(review.getByRole("region", { name: "Affected statements" })).toContainText(original);
  expect(requests).toHaveLength(2);
});
