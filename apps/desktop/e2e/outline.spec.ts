import { expect, type Page, test } from "@playwright/test";
import { launch } from "./memory-platform.ts";

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
const text = [
  "# Guide",
  filler(3),
  "## Install",
  filler(40),
  "## Usage *basics*",
  filler(40),
  "### Details",
  filler(40),
  "",
].join("\n\n");

const outline = (page: Page) => page.getByRole("navigation", { name: "Outline" });
const entry = (page: Page, name: string) => outline(page).getByRole("link", { name, exact: true });
const current = (page: Page) => outline(page).locator("[aria-current=location]");
const content = (page: Page) => page.locator(".cm-content");

async function openDocument(page: Page, options: { folder?: boolean } = {}) {
  const path = "/notes/guide.md";
  await launch(page, {
    files: { [path]: text, "/notes/other.md": "# Other\n" },
    openDialogResults: [path],
    openFolderDialogResults: ["/notes"],
    locale: "en-US",
  });
  if (options.folder) await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.keyboard.press("ControlOrMeta+O");
  await expect(content(page)).toBeFocused();
}

async function showOutline(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("dialog", { name: "Command Palette" }).getByRole("combobox").fill("outline");
  await page.keyboard.press("Enter");
  await expect(outline(page)).toBeVisible();
}

test("the sidebar shows the outline of the document, updated as it is edited", async ({ page }) => {
  await openDocument(page);
  await showOutline(page);

  const names = outline(page).getByRole("link");
  await expect(names).toHaveText(["Guide", "Install", "Usage basics", "Details"]);

  // Turn the first paragraph into a heading.
  await content(page).getByText("Paragraph 1.", { exact: true }).first().click();
  await page.keyboard.press("Home");
  await page.keyboard.type("## ");
  await expect(names).toHaveText(["Guide", "Paragraph 1.", "Install", "Usage basics", "Details"]);
  await page.keyboard.type("New ");
  await expect(names).toHaveText([
    "Guide",
    "New Paragraph 1.",
    "Install",
    "Usage basics",
    "Details",
  ]);
});

test("clicking a heading jumps to it, and the current section is highlighted", async ({ page }) => {
  await openDocument(page);
  await showOutline(page);
  await expect(current(page)).toHaveText("Guide");

  await entry(page, "Usage basics").click();
  await expect(current(page)).toHaveText("Usage basics");
  await expect(content(page)).toBeFocused();
  const heading = content(page).getByRole("heading", { name: /Usage/ });
  await expect(heading).toBeInViewport();
  // The heading is scrolled to the top of the editor.
  const scroller = await page.locator(".cm-scroller").boundingBox();
  const box = await heading.boundingBox();
  expect(Math.abs((box?.y ?? 0) - (scroller?.y ?? 0))).toBeLessThan(10);

  // The cursor is on the heading.
  await page.keyboard.press("End");
  await page.keyboard.type(" now");
  await expect(entry(page, "Usage basics now")).toBeVisible();
});

test("moving the cursor highlights the section it is in", async ({ page }) => {
  await openDocument(page);
  await showOutline(page);
  await expect(current(page)).toHaveText("Guide");

  await page.keyboard.press("ControlOrMeta+End");
  await expect(current(page)).toHaveText("Details");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(current(page)).toHaveText("Guide");
});

test("scrolling highlights the section at the top of the editor", async ({ page }) => {
  await openDocument(page);
  await showOutline(page);
  await expect(current(page)).toHaveText("Guide");

  const scroller = page.locator(".cm-scroller");
  // Scroll the "Usage" heading just past the top, without moving the cursor. Lines
  // are rendered only near the visible part, so scroll down until it is rendered.
  const found = await scroller.evaluate(async (el) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (let y = 0; y < el.scrollHeight; y += el.clientHeight / 2) {
      el.scrollTo(0, y);
      await frame();
      await frame();
      const line = [...el.querySelectorAll(".cm-line")].find(
        (l) => l.textContent === "Usage basics",
      );
      if (line) {
        const offset = line.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTo(0, el.scrollTop + offset + 40);
        return true;
      }
    }
    return false;
  });
  expect(found).toBe(true);
  await expect(current(page)).toHaveText("Usage basics");

  await scroller.evaluate((el) => el.scrollTo(0, 0));
  await expect(current(page)).toHaveText("Guide");
});

test("with a folder open, the sidebar switches between the file tree and the outline", async ({
  page,
}) => {
  await openDocument(page, { folder: true });
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("tree")).toBeVisible();

  await sidebar.getByRole("button", { name: "Outline" }).click();
  await expect(outline(page)).toBeVisible();
  await expect(sidebar.getByRole("tree")).toBeHidden();
  await expect(outline(page).getByRole("link")).toHaveText([
    "Guide",
    "Install",
    "Usage basics",
    "Details",
  ]);

  await sidebar.getByRole("button", { name: "Files" }).click();
  await expect(sidebar.getByRole("tree")).toBeVisible();
  await sidebar.getByRole("treeitem", { name: "other.md" }).click();
  await sidebar.getByRole("button", { name: "Outline" }).click();
  // The outline follows the active document.
  await expect(outline(page).getByRole("link")).toHaveText(["Other"]);
});

test("a document without headings has an empty outline", async ({ page }) => {
  const path = "/plain.md";
  await launch(page, {
    files: { [path]: "just text\n" },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await showOutline(page);
  await expect(outline(page)).toContainText("No headings");
});

test("Typora's outline shortcut toggles the outline", async ({ page }) => {
  await openDocument(page);
  const shortcut = process.platform === "darwin" ? "Meta+Control+1" : "Control+Shift+1";
  await page.keyboard.press(shortcut);
  await expect(outline(page)).toBeVisible();
  await page.keyboard.press(shortcut);
  await expect(outline(page)).toBeHidden();
});
