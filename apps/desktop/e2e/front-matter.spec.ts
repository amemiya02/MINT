import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

const post = "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n";

test("front matter opens folded, unfolds by click or keyboard, and edits stay inside it", async ({
  page,
}) => {
  const path = "/blog/post.md";
  await launch(page, { files: { [path]: post }, openDialogResults: [path], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");

  const folded = page.locator(".cm-mint-front-matter");
  await expect(folded).toContainText("title, tags");
  await expect(page.getByText("title: Hello")).toHaveCount(0);

  // Click to unfold: the cursor lands on the first field.
  await folded.click();
  await expect(folded).toHaveCount(0);
  await page.keyboard.press("End");
  await page.keyboard.type(" World");

  // Leave by keyboard: the block folds again.
  await page.keyboard.press("ControlOrMeta+End");
  await expect(folded).toContainText("title, tags");

  // Enter by keyboard from the line below: the block unfolds.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(folded).toHaveCount(0);
  await expect(page.getByText("title: Hello World")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(post.replace("Hello", "Hello World"));
});
