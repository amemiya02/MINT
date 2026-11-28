import { expect, test } from "@playwright/test";
import { launch, readFile, runMenuItem } from "./memory-platform.ts";

test("a material-based draft links conclusions to the exact excerpts sent", async ({ page }) => {
  const address = "https://sources.example.test/v1";
  const instruction = "Draft a short bulletin from the two field records.";
  const supported = "The north ridge reopened Tuesday.";
  const unsupported = "The south trail reopened too.";
  const unlisted = "There were no delays.";
  const generated = `${supported} ${unsupported} ${unlisted}`;
  const excerpt = "Crews reopened the north ridge on Tuesday.";
  const otherExcerpt = "The south trail is still closed.";
  const reply = `${generated}\n\n<source-passages>\n${JSON.stringify([
    { claim: supported, material: 1, quote: excerpt },
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
  await runMenuItem(page, "edit.allWritingTasks");
  await page
    .getByRole("dialog", { name: "All writing tasks" })
    .getByRole("button", { name: instruction, exact: true })
    .click();
  await review.getByRole("button", { name: supported, exact: true }).click();
  await expect(passage.getByText(excerpt, { exact: true })).toBeVisible();
  await passage.getByRole("button", { name: "Insert Markdown citation" }).click();
  await runMenuItem(page, "file.save");
  await expect
    .poll(() => readFile(page, draftPath))
    .toBe(
      `${supported}[^mint-source-1] ${unsupported} ${unlisted}\n\n[^mint-source-1]: ridge.md, line 2 of sent material. “${excerpt}”\n`,
    );
  expect(sends).toBe(1);
});
