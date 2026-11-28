import { expect, type Page, test } from "@playwright/test";
import { externalWrite, launch, readFile } from "./memory-platform.ts";

const path = "/notes/trips/draft.md";
const source =
  "\uFEFF---\r\ntitle: Research\r\nstatus: 'Draft'  # keep\r\n---\r\n\r\nDraft body  \r\n";

async function openBoard(page: Page) {
  await launch(page, {
    locale: "en-US",
    files: { [path]: source, "/notes/done.md": "---\nstatus: Done\n---\n" },
    openFolderDialogResults: ["/notes"],
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings
    .getByRole("group", { name: "Kanban board" })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await settings.getByRole("button", { name: "Allow access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const entry = page
    .getByRole("navigation", { name: "Document tools" })
    .getByRole("button", { name: "Kanban board" });
  await entry.click();
  return { entry, board: page.getByRole("complementary", { name: "Kanban board" }), settings };
}

test("moving a card preserves the rest of its source and survives reopening the board", async ({
  page,
}) => {
  const { board, entry } = await openBoard(page);
  const draft = board.getByRole("region", { name: "Draft", exact: true });
  const done = board.getByRole("region", { name: "Done", exact: true });
  await expect(draft.getByRole("button", { name: "trips/draft.md" })).toBeVisible();
  await expect(done.getByRole("button", { name: "done.md" })).toBeVisible();
  await draft
    .getByRole("combobox", { name: "Move trips/draft.md" })
    .selectOption({ label: "Done" });
  await expect(done.getByRole("button", { name: "trips/draft.md" })).toBeVisible();
  expect(await readFile(page, path)).toBe(source.replace("'Draft'", "'Done'"));
  await entry.click();
  await entry.click();
  const moved = done
    .getByRole("article")
    .filter({ has: page.getByRole("button", { name: "trips/draft.md" }) });
  await expect(moved).toBeVisible();
  const next = board.getByRole("region", { name: "In progress", exact: true });
  await moved.dragTo(next);
  await expect(next.getByRole("button", { name: "trips/draft.md" })).toBeVisible();
  expect(await readFile(page, path)).toBe(source.replace("'Draft'", "'In progress'"));
});

test("after an external change a failed move shows the status actually on disk", async ({
  page,
}) => {
  const { board } = await openBoard(page);
  const move = board.getByRole("combobox", { name: "Move trips/draft.md" });
  await expect(move).toBeEnabled();
  const changed = `${source.replace("'Draft'", "'In review'")}External edit.`;
  await externalWrite(page, path, changed);
  await move.selectOption("Done");
  await expect(board.getByRole("alert")).toContainText("trips/draft.md");
  await expect(
    board
      .getByRole("region", { name: "In review", exact: true })
      .getByRole("button", { name: "trips/draft.md" }),
  ).toBeVisible();
  expect(await readFile(page, path)).toBe(changed);
});

test("a writer can browse cards after denying status changes", async ({ page }) => {
  const { board, settings } = await openBoard(page);
  await page.keyboard.press("ControlOrMeta+,");
  const writeAction = settings
    .getByRole("group", { name: "Kanban board" })
    .locator("div")
    .filter({
      has: page.getByText(
        "Change the status property of Markdown documents in the current folder",
        { exact: true },
      ),
    });
  await writeAction.getByRole("button", { name: "Revoke access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const draft = board.getByRole("region", { name: "Draft", exact: true });
  const done = board.getByRole("region", { name: "Done", exact: true });
  await expect(draft.getByRole("combobox", { name: "Move trips/draft.md" })).toBeDisabled();
  await draft.getByRole("article").dragTo(done);
  await expect(draft.getByRole("button", { name: "trips/draft.md" })).toBeVisible();
  expect(await readFile(page, path)).toBe(source);
});
