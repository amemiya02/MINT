import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

test("a writer grants folder access to browse tags and open the original document", async ({
  page,
}) => {
  const draft = "---\ntags: [research, Tokyo]\n---\n\nField notes.\n";
  await launch(page, {
    locale: "en-US",
    files: {
      "/notes/trips/draft.md": draft,
      "/notes/tasks.md": "---\ntags:\n  - work\n---\n\nTasks.",
      "/elsewhere/private.md": "---\ntags: [private]\n---\n",
    },
    openFolderDialogResults: ["/notes"],
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  const entry = page
    .getByRole("navigation", { name: "Document tools" })
    .getByRole("button", { name: "Tag browser" });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const plugin = settings.getByRole("group", { name: "Tag browser" });
  await plugin.getByRole("button", { name: "Install", exact: true }).click();
  await expect(settings.getByText("Read Markdown documents in the current folder")).toBeVisible();
  await settings.getByRole("button", { name: "Deny access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await entry.click();
  const view = page.getByRole("complementary", { name: "Tag browser" });
  await expect(view.getByRole("alert")).toContainText("denied");
  await expect(view.getByRole("combobox")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Allow access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  const filter = view.getByRole("combobox", { name: "Tag" });
  await filter.selectOption("work");
  await expect(view.getByRole("button", { name: "tasks.md" })).toBeVisible();
  await filter.selectOption("research");
  await expect(filter.getByRole("option", { name: "private" })).toHaveCount(0);
  await expect(view.getByRole("button", { name: "tasks.md" })).toHaveCount(0);
  await view.getByRole("button", { name: "trips/draft.md" }).click();
  await expect(page.getByRole("main").getByRole("textbox")).toContainText("Field notes.");
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Disable" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(entry).toHaveCount(0);
  await expect(view).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Enable" }).click();
  await plugin.getByRole("button", { name: "Uninstall" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await expect(entry).toHaveCount(0);
  expect(await readFile(page, "/notes/trips/draft.md")).toBe(draft);
});
