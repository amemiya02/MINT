import { expect, type Page, test } from "@playwright/test";
import { launch, listPaths, readFile } from "./memory-platform.ts";

const folder = "/notebook";
const draft = `${folder}/draft.md`;
const command = "Open today’s journal";
const permission = "Create today’s Markdown journal in the current folder and open it";
const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });

async function setup(page: Page) {
  await launch(page, {
    locale: "en-US",
    files: { [draft]: "Keep this draft.  \r\n" },
    openedPaths: [{ kind: "directory", path: folder }],
  });
  await expect(page.getByRole("treeitem", { name: "draft.md" })).toBeVisible();
}

async function install(page: Page, allow: boolean) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = settings(page);
  const plugin = dialog.getByRole("group", { name: "Daily journal" });
  await expect(plugin).toBeVisible();
  await plugin.getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog.getByText(permission, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: allow ? "Allow access" : "Deny access" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}

async function openJournal(page: Page) {
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox").fill(command);
  await page.keyboard.press("Enter");
}

test("denying journal creation leaves the current folder untouched", async ({ page }) => {
  await setup(page);
  await install(page, false);
  await openJournal(page);
  await expect(page.getByRole("alert")).toContainText("Journal access was denied");
  expect((await listPaths(page)).filter((path) => path.startsWith(`${folder}/`))).toEqual([draft]);
  expect(await readFile(page, draft)).toBe("Keep this draft.  \r\n");
});

test.use({ timezoneId: "America/Los_Angeles" });

test("the journal command creates a dated Markdown entry and reuses its draft that day", async ({
  page,
}) => {
  // It is already November 29 in UTC.
  await page.clock.setFixedTime(new Date("2026-11-29T02:00:00Z"));
  await setup(page);
  await install(page, true);
  await openJournal(page);
  const filename = "2026-11-28.md";
  const path = `${folder}/${filename}`;
  await expect(page).toHaveTitle(`${filename} — MINT`);
  await expect.poll(() => readFile(page, path)).toBe("# 2026-11-28\n\n");
  await page.locator(".cm-content:visible").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("Field notes.");
  await page.getByRole("treeitem", { name: "draft.md" }).click();
  await expect(page).toHaveTitle("draft.md — MINT");
  await openJournal(page);
  await expect(page.locator(".cm-content:visible")).toContainText("Field notes.");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(page, path)).toBe("# 2026-11-28\n\nField notes.");
  await expect(page.getByRole("tab", { name: filename })).toHaveCount(1);
  expect((await listPaths(page)).filter((p) => p.startsWith(`${folder}/`))).toEqual([path, draft]);
});

test("a directory with the journal filename is preserved and reported", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-11-29T02:00:00Z"));
  const collision = `${folder}/2026-11-28.md`;
  const child = `${collision}/child.md`;
  await launch(page, {
    locale: "en-US",
    files: { [child]: "Keep this child" },
    openedPaths: [{ kind: "directory", path: folder }],
  });
  await expect(page.getByRole("treeitem", { name: "2026-11-28.md" })).toBeVisible();
  await install(page, true);
  await openJournal(page);
  await expect(page.getByRole("alert")).toContainText(`Could not open the journal ${collision}`);
  expect(await readFile(page, collision)).toBeUndefined();
  expect(await readFile(page, child)).toBe("Keep this child");
});

test("a local package supplies its journal template only while its command is enabled", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-29T02:00:00Z"));
  await setup(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = settings(page);
  await dialog.getByLabel("Install a MINT plugin file").setInputFiles({
    name: "field-journal.mint.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        apiVersion: 1,
        id: "example.field-journal",
        name: "Field journal",
        permissions: ["folder.journal.create"],
        journalTemplate: "# Observations for {{date}}\n\n- ",
      }),
    ),
  });
  await expect(dialog.getByText(permission, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Allow access" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox").fill("Field journal");
  await page.getByRole("option", { name: /Field journal/ }).click();
  await expect
    .poll(() => readFile(page, `${folder}/2026-11-28.md`))
    .toBe("# Observations for 2026-11-28\n\n- ");
  await page.keyboard.press("ControlOrMeta+,");
  await dialog
    .getByRole("group", { name: "Field journal" })
    .getByRole("button", { name: "Disable" })
    .click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox").fill("Field journal");
  await expect(page.getByText("No matching commands")).toBeVisible();
});
