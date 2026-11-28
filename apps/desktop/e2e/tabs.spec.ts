import { expect, test } from "@playwright/test";
import { launch, questionsAsked, readFile, settingsPath } from "./memory-platform.ts";

const files = {
  "/notes/a.md": "# Alpha\n",
  "/notes/b.md": "# Beta\n",
  // These tests are about unsaved changes, so autosave must not save them meanwhile.
  [settingsPath]: '{ "autosave": false }',
};

test("open several documents in tabs and switch between them", async ({ page }) => {
  await launch(page, { files, openDialogResults: ["/notes/a.md", "/notes/b.md"], locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Beta");

  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveTitle("b.md — MINT");

  await page.getByRole("tab", { name: "a.md" }).click();
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await expect(page).toHaveTitle("a.md — MINT");
});

test("switch tabs from the keyboard", async ({ page }) => {
  await launch(page, { files, openDialogResults: ["/notes/a.md", "/notes/b.md"], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Beta");

  await page.keyboard.press("Control+Tab");
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+Shift+Tab");
  await expect(page.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true");
});

test("opening a document that is already open focuses its tab", async ({ page }) => {
  await launch(page, {
    files,
    openDialogResults: ["/notes/a.md", "/notes/b.md", "/notes/a.md"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.type("edited ");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Beta");

  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab")).toHaveCount(2);
  // The existing tab, with its unsaved edit, not a fresh copy from disk.
  await expect(page.getByRole("textbox")).toContainText("edited # Alpha");
});

test("closing a tab with unsaved changes asks first; cancel keeps it, don't save discards", async ({
  page,
}) => {
  await launch(page, {
    files,
    openDialogResults: ["/notes/a.md"],
    questionDialogResults: ["cancel", "no"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.type("draft ");

  await page.getByRole("button", { name: "Close a.md" }).click();
  await expect.poll(() => questionsAsked(page)).toHaveLength(1);
  expect((await questionsAsked(page))[0]).toContain("a.md");
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("No document open")).toBeVisible();
  expect(await readFile(page, "/notes/a.md")).toBe("# Alpha\n");
});

test("closing a tab with unsaved changes can save them", async ({ page }) => {
  await launch(page, {
    files,
    openDialogResults: ["/notes/a.md"],
    questionDialogResults: ["yes"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.type("draft ");

  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.getByRole("tab")).toHaveCount(0);
  expect(await readFile(page, "/notes/a.md")).toBe("draft # Alpha\n");
});

test("closing a saved tab does not ask and shows the neighbouring tab", async ({ page }) => {
  await launch(page, { files, openDialogResults: ["/notes/a.md", "/notes/b.md"], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Beta");

  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  expect(await questionsAsked(page)).toEqual([]);
});

test("closing a window with unsaved changes asks first and can be cancelled", async ({ page }) => {
  await launch(page, {
    files,
    openDialogResults: ["/notes/a.md"],
    questionDialogResults: ["cancel"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("textbox")).toContainText("# Alpha");
  await page.keyboard.type("draft ");

  const closed = await page.evaluate(async () => {
    const platform = (
      window as unknown as {
        __MINT_MEMORY_PLATFORM__: { closeWindow(): Promise<void>; closed: boolean };
      }
    ).__MINT_MEMORY_PLATFORM__;
    await platform.closeWindow();
    return platform.closed;
  });
  expect(closed).toBe(false);
  expect(await questionsAsked(page)).toHaveLength(1);
  await expect(page.getByRole("textbox")).toContainText("draft # Alpha");
});

test("a new window has its own independent tabs", async ({ page }) => {
  await launch(page, { files, openDialogResults: ["/notes/a.md", "/notes/b.md"], locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("tab", { name: "a.md" })).toBeVisible();

  const [second] = await Promise.all([
    page.waitForEvent("popup"),
    page.keyboard.press("ControlOrMeta+Shift+N"),
  ]);
  await expect(second.getByText("No document open")).toBeVisible();
  await expect(second).toHaveTitle("MINT");

  await second.getByRole("button", { name: "Open Document…" }).click();
  await expect(second.getByRole("tab", { name: "a.md" })).toBeVisible();
  await second.keyboard.press("ControlOrMeta+W");
  await expect(second.getByRole("tab")).toHaveCount(0);

  // The first window is untouched by what happened in the second.
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveTitle("a.md — MINT");
});

test("compare a reference tab beside a draft and return to its unsaved edit", async ({ page }) => {
  await launch(page, {
    files,
    openDialogResults: ["/notes/a.md", "/notes/b.md", "/notes/a.md"],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const draft = page.getByRole("tabpanel", { name: "a.md" }).getByRole("textbox");
  await expect(draft).toBeFocused();
  await page.keyboard.type("draft ");
  await page.keyboard.press("ControlOrMeta+O");
  const reference = page.getByRole("tabpanel", { name: "b.md" }).getByRole("textbox");
  await expect(reference).toBeFocused();
  await page.getByRole("button", { name: "Open b.md in other pane" }).click();
  await expect(draft).toBeVisible();
  await expect(reference).toBeFocused();
  await expect(page.getByRole("tablist")).toHaveCount(2);
  await page.keyboard.type("reference ");
  await page.keyboard.press("ControlOrMeta+S");
  await expect.poll(() => readFile(page, "/notes/b.md")).toBe("reference # Beta\n");
  expect(await readFile(page, "/notes/a.md")).toBe("# Alpha\n");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(draft).toBeFocused();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await page.getByRole("button", { name: "Close reference pane" }).click();
  await expect(draft).toBeFocused();
  await expect(reference).toBeHidden();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(draft).toContainText("# Alpha");
  await expect(draft).not.toContainText("draft ");
});

test("pane commands preserve each selection and reading position and route find and outline", async ({
  page,
}) => {
  const long = Array.from({ length: 250 }, (_, i) => `Paragraph ${i}`).join("\n\n");
  await launch(page, {
    files: {
      ...files,
      "/notes/a.md": `# Alpha\n\n${long}\n\nAlpha tail`,
      "/notes/c.md": "# Gamma",
    },
    openDialogResults: ["/notes/a.md", "/notes/b.md", "/notes/c.md"],
    locale: "en-US",
  });
  const command = async (name: string) => {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.getByRole("dialog", { name: "Command Palette" }).getByRole("combobox").fill(name);
    await page.keyboard.press("Enter");
  };
  await page.keyboard.press("ControlOrMeta+O");
  const draftPanel = page.getByRole("tabpanel", { name: "a.md" });
  const draft = draftPanel.getByRole("textbox");
  await expect(draft).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Shift+Home");
  await expect(draft.getByText("Alpha tail", { exact: true })).toBeInViewport();
  await page.keyboard.press("ControlOrMeta+O");
  const reference = page.getByRole("tabpanel", { name: "b.md" }).getByRole("textbox");
  await expect(reference).toBeFocused();
  await command("Open in other pane");
  await expect(draft).toBeVisible();
  await command("Outline");
  const outline = page.getByRole("navigation", { name: "Outline" });
  await expect(outline.getByRole("link", { name: "Beta" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await find.fill("Beta");
  await expect(page.getByRole("search").getByRole("status")).toContainText("1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("tablist").nth(1).getByRole("tab", { name: "c.md" })).toBeVisible();
  await page.keyboard.press("Control+Tab");
  await expect(reference).toBeFocused();
  await command("Focus other pane");
  await expect(draft).toBeFocused();
  await expect(outline.getByRole("link", { name: "Alpha" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+/");
  await command("Close reference pane");
  await expect(draft).toBeFocused();
  await expect(draft.getByText("Alpha tail", { exact: true })).toBeInViewport();
  await page.keyboard.type("replaced tail");
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(page, "/notes/a.md"))
    .toBe(`# Alpha\n\n${long}\n\nreplaced tail`);
});

test("two views of one manuscript share edits and undo while keeping their selections", async ({
  page,
}) => {
  const path = "/notes/manuscript.md";
  const source = "Definition\n\nConclusion";
  await launch(page, {
    files: { ...files, [path]: source },
    openDialogResults: [path, path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const left = page.getByRole("textbox").first();
  await expect(left).toBeFocused();
  await page.keyboard.press("Shift+End");
  await page.getByRole("button", { name: "Open manuscript.md in other pane" }).click();
  const right = page.getByRole("textbox").nth(1);
  await expect(right).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("!");
  await expect(page.getByTitle("Unsaved changes")).toHaveCount(2);
  await expect(left).toContainText("Conclusion!");
  await page.getByRole("tab", { name: "manuscript.md" }).first().click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(right).not.toContainText("Conclusion!");
  await expect(page.getByTitle("Unsaved changes")).toHaveCount(0);
  await page.keyboard.type("Term");
  await expect(right).toContainText("Term");
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("button", { name: "Close manuscript.md", exact: true }).first().click();
  await expect(page.getByRole("textbox")).toHaveCount(1);
  expect(await questionsAsked(page)).toEqual([]);
  await page.keyboard.type("!");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(page, path)).toBe("Term\n\nConclusion!");
});

test("each view of a long manuscript keeps its chapter while editing and undoing", async ({
  page,
}) => {
  const path = "/notes/chapters.md";
  const middle = Array.from({ length: 220 }, (_, i) => `Paragraph ${i}.`).join("\r\n\r\n");
  const draft = `\uFEFFDefinition\r\n\r\n${middle}\n\nConclusion`;
  await launch(page, {
    files: { ...files, [path]: draft },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const left = page.getByRole("textbox").first();
  await expect(left).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" draft");
  await page.keyboard.press("Shift+Home");
  await page.getByRole("button", { name: "Open chapters.md in other pane" }).click();
  const right = page.getByRole("textbox").nth(1);
  await expect(right).toBeFocused();
  await expect(right.getByText("Definition", { exact: true })).toBeInViewport();
  await expect(left.getByText("Conclusion draft", { exact: true })).toBeInViewport();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(left.getByText("Conclusion", { exact: true })).toBeInViewport();
  await expect(right.getByText("Definition", { exact: true })).toBeInViewport();
  await page.keyboard.type("New ");
  await page.getByRole("button", { name: "Close reference pane" }).click();
  await expect(left.getByText("Conclusion", { exact: true })).toBeInViewport();
  await page.keyboard.type("Summary");
  await page.keyboard.press("ControlOrMeta+s");
  await expect
    .poll(() => readFile(page, path))
    .toBe(draft.replace("Definition", "New Definition").replace("Conclusion", "Summary"));
});
