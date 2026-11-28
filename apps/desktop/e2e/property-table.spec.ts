import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

test("a writer grants access to browse folder properties and open original Markdown", async ({
  page,
}) => {
  const draft = "---\nstatus: draft\nreviewed: false\n---\n\nField notes.\n";
  await launch(page, {
    locale: "en-US",
    openFolderDialogResults: ["/notes"],
    files: {
      "/notes/trips/draft.md": draft,
      "/notes/final.md": "---\nstatus: published\ntopics: [travel, food]\n---\n",
      "/notes/plain.md": "No properties",
      "/other/private.md": "---\nsecret: hidden\n---\n",
    },
  });
  await page.getByRole("button", { name: "Open Folder…" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const plugin = settings.getByRole("group", { name: "Property table" });
  const close = settings.getByRole("button", { name: "Close", exact: true });
  await page.keyboard.press("ControlOrMeta+,");
  await expect(plugin).toBeVisible();
  await plugin.getByRole("button", { name: "Install", exact: true }).click();
  await settings.getByRole("button", { name: "Deny access" }).click();
  await close.click();
  const entry = page
    .getByRole("navigation", { name: "Document tools" })
    .getByRole("button", { name: "Property table" });
  await entry.click();
  const view = page.getByRole("complementary", { name: "Property table" });
  await expect(view.getByRole("alert")).toContainText("denied");
  await expect(view.getByRole("row")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Allow access" }).click();
  await close.click();
  await expect(view.getByRole("columnheader")).toHaveText([
    "Document",
    "reviewed",
    "status",
    "topics",
  ]);
  await expect(view.getByRole("row")).toHaveCount(4);
  await expect(view.getByRole("row", { name: /trips\/draft.md/ }).getByRole("cell")).toHaveText([
    "false",
    "draft",
    "—",
  ]);
  await expect(view.getByRole("row", { name: /final.md/ }).getByRole("cell")).toHaveText([
    "—",
    "published",
    "[ travel, food ]",
  ]);
  await expect(view.getByRole("row", { name: /plain.md/ }).getByRole("cell")).toHaveText([
    "—",
    "—",
    "—",
  ]);
  await view.getByRole("button", { name: "trips/draft.md" }).click();
  await expect(page.getByRole("main").getByRole("textbox")).toContainText("Field notes.");
  expect(await readFile(page, "/notes/trips/draft.md")).toBe(draft);
  await page.keyboard.press("ControlOrMeta+,");
  await plugin.getByRole("button", { name: "Disable" }).click();
  await close.click();
  await expect(view).toHaveCount(0);
  await expect(entry).toHaveCount(0);
});
