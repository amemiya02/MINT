import { expect, test } from "@playwright/test";
import { launch, openedUrls, readClipboardText, readFile } from "./memory-platform.ts";

test("renders inline spans and ⌘/ switches to source mode without moving the cursor", async ({
  page,
}) => {
  const path = "/notes/style.md";
  await launch(page, {
    files: { [path]: "Some **bold** text\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");

  const line = page.locator(".cm-line").first();
  await expect(line).toHaveText("Some bold text");

  await page.keyboard.press("ControlOrMeta+/");
  await expect(line).toHaveText("Some **bold** text");
  await expect(page.getByText("Source Mode")).toBeVisible();

  await page.keyboard.type("X");
  await page.keyboard.press("ControlOrMeta+/");
  await expect(line).toHaveText("XSome bold text");
  await expect(page.getByText("Live Preview")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe("XSome **bold** text\n");
});

test("⌘-click opens external links in the browser and local documents in MINT", async ({
  page,
}) => {
  const path = "/notes/index.md";
  await launch(page, {
    files: {
      [path]: "Go: [next](sub/next.md) or [site](https://example.com/)\n",
      "/notes/sub/next.md": "# Next page\n",
    },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");

  await page.getByText("site", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(() => openedUrls(page)).toEqual(["https://example.com/"]);

  await page.getByText("next", { exact: true }).click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveTitle("next.md — MINT");
  await expect(page.getByRole("textbox")).toContainText("Next page");
});

test("a find match inside hidden markers reveals them while it is selected", async ({ page }) => {
  const path = "/notes/find.md";
  await launch(page, {
    files: { [path]: "plain\n\nA **cat** here\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const line = page.locator(".cm-line").nth(2);
  await expect(line).toHaveText("A cat here");

  await page.keyboard.press("ControlOrMeta+F");
  const find = page.getByRole("textbox", { name: "Find" });
  await find.fill("cat");
  await find.press("Enter");
  await expect(page.getByText("1 of 1")).toBeVisible();
  await expect(line).toHaveText("A **cat** here");
  await expect(line.locator(".mint-find-match-current")).toHaveText("cat");

  await find.press("Escape");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(line).toHaveText("A cat here");
});

test("dragging in a code block visibly selects text that the copy shortcut copies", async ({
  context,
  page,
}) => {
  const path = "/notes/select-code.md";
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await launch(page, {
    files: { [path]: "Example\n\n```\nalpha beta gamma\n  delta epsilon\n```\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");

  const firstLine = page.locator(".cm-line", { hasText: "alpha beta gamma" });
  const secondLine = page.locator(".cm-line", { hasText: "delta epsilon" });
  await expect(firstLine).toBeVisible();
  const start = await firstLine.boundingBox();
  const end = await secondLine.boundingBox();
  if (!start || !end) throw new Error("Code lines are not visible");
  // The selection extends past the first line's text when dragged onto the second line.
  const clip = { x: Math.round(start.x + 200), y: Math.round(start.y + 8), width: 1, height: 1 };
  const unselected = await page.screenshot({ clip, scale: "css" });

  await page.mouse.move(start.x + 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 200, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+C");

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("alpha beta gamma\n  delta epsilon");
  expect(await page.screenshot({ clip, scale: "css" })).not.toEqual(unselected);
});

test("the code block buttons copy only their own code, preserving whitespace", async ({ page }) => {
  const path = "/notes/copy-code.md";
  await launch(page, {
    files: {
      [path]:
        "Examples\n\n```js\n  run();  \n\n  stop();\n```\n\n> ~~~\n>   hello\n>   world\n> ~~~\n",
    },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");

  const buttons = page.getByRole("button", { name: "Copy code block" });
  await expect(buttons).toHaveCount(2);
  await buttons.first().click();
  await expect.poll(() => readClipboardText(page)).toBe("  run();  \n\n  stop();");
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  await expect(page.getByText("js", { exact: true })).toBeVisible();

  await page.getByText("hello", { exact: true }).click();
  await buttons.last().focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => readClipboardText(page)).toBe("  hello\n  world");
});
