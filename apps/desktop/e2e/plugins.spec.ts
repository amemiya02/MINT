import { expect, test } from "@playwright/test";
import {
  launch,
  pickFile,
  readFile,
  runMenuItem,
  savedDialogs,
  settingsPath,
} from "./memory-platform.ts";

test("a writer controls access to the active draft and manages the statistics plugin", async ({
  page,
}) => {
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+n");
  await page.locator(".cm-content").fill("first draft");
  const settings = async () => {
    await page.keyboard.press("ControlOrMeta+,");
    return page.getByRole("dialog", { name: "Settings" });
  };
  const dialog = await settings();
  await dialog
    .getByRole("group", { name: "Writing statistics" })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await expect(dialog.getByText("Read the current document")).toBeVisible();
  await dialog.getByRole("button", { name: "Deny access" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const entry = page.getByRole("button", { name: "Writing statistics" });
  await entry.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Permission to read the current document was denied.",
  );
  await page.keyboard.press("Escape");
  await settings();
  await dialog.getByRole("button", { name: "Allow access" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await entry.click();
  await expect(page.getByRole("dialog")).toContainText("Words: 2");
  await page.keyboard.press("Escape");
  await settings();
  await dialog.getByRole("button", { name: "Disable" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(entry).toHaveCount(0);
  await page.reload();
  await settings();
  await dialog.getByRole("button", { name: "Enable" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(entry).toBeVisible();
  await settings();
  await dialog.getByRole("button", { name: "Uninstall" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(entry).toHaveCount(0);
  await settings();
  await expect(
    dialog
      .getByRole("group", { name: "Writing statistics" })
      .getByRole("button", { name: "Install", exact: true }),
  ).toBeVisible();
});

test("a local MINT plugin contributes the document metrics its author selected", async ({
  page,
}) => {
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+n");
  await page.locator(".cm-content").fill("An unsaved draft.");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const input = settings.getByRole("button", { name: "Install a MINT plugin file" });
  const manifest = {
    apiVersion: 1,
    id: "example.characters",
    name: "Character budget",
    statistics: ["characters"],
    permissions: ["document.read"],
  };
  const file = (data: object) => ({
    name: "character-budget.mint.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await pickFile(page, input, file({ ...manifest, permissions: ["folder.read"] }));
  await expect(settings.getByRole("alert")).toContainText("Unsupported plugin package");
  await pickFile(page, input, file(manifest));
  await settings.getByRole("button", { name: "Allow access" }).click();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Character budget" }).click();
  const view = page.getByRole("dialog", { name: "Character budget" });
  await expect(view).toContainText("Characters: 15");
  await expect(view).not.toContainText("Words:");
});

test("another window can revoke a live view, and enabling it again leaves it closed", async ({
  page,
  context,
}) => {
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+n");
  await page.locator(".cm-content").fill("draft");
  await page.keyboard.press("ControlOrMeta+,");
  await page
    .getByRole("group", { name: "Writing statistics" })
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await page.getByRole("button", { name: "Allow access" }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Writing statistics" }).click();
  const view = page.getByRole("dialog", { name: "Writing statistics" });
  await expect(view).toContainText("Words: 1");
  const manager = await context.newPage();
  await manager.goto("/");
  await expect(manager.getByText("No document open")).toBeVisible();
  await manager.keyboard.press("ControlOrMeta+,");
  await manager.getByRole("button", { name: "Revoke access" }).click();
  await expect(view.getByRole("alert")).toContainText("Permission");
  await expect(view).not.toContainText("Words:");
  await manager.getByRole("button", { name: "Disable" }).click();
  await expect(view).toHaveCount(0);
  await manager.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByRole("button", { name: "Writing statistics" })).toBeVisible();
  await expect(view).toHaveCount(0);
});

const original = {
  apiVersion: 1,
  id: "example.draft",
  name: "Draft metrics",
  permissions: ["document.read"],
  statistics: ["words"],
};
const upload = (manifest: object) => ({
  name: "draft.mint.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(manifest)),
});

test("updating a local plugin retains its existing document grant", async ({ page }) => {
  // Open an installation saved by an earlier MINT release.
  await page.addInitScript((manifest) => {
    localStorage.setItem(
      `mint.plugin.v1.${manifest.id}`,
      JSON.stringify({ manifest, enabled: true, granted: true }),
    );
  }, original);
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+n");
  await page.locator(".cm-content").fill("draft");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const input = settings.getByRole("button", { name: "Install a MINT plugin file" });
  await pickFile(
    page,
    input,
    upload({ ...original, name: "Draft size", statistics: ["characters"] }),
  );
  await expect(settings.getByRole("group", { name: "Draft size" })).toBeVisible();
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Draft size" }).click();
  await expect(page.getByRole("dialog", { name: "Draft size" })).toContainText("Characters: 5");
});

test("a writer can decline an additional action, then approve the update", async ({ page }) => {
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+n");
  const editor = page.locator(".cm-content:visible");
  await editor.fill("another open draft");
  await page.keyboard.press("ControlOrMeta+n");
  await editor.fill("draft");
  const settings = page.getByRole("dialog", { name: "Settings" });
  const input = settings.getByRole("button", { name: "Install a MINT plugin file" });
  const close = settings.getByRole("button", { name: "Close", exact: true });
  const expanded = {
    ...original,
    name: "Draft toolkit",
    permissions: ["document.write", "document.read"],
    templates: [{ name: "Review marker", text: "REVIEW" }],
  };
  await page.keyboard.press("ControlOrMeta+,");
  await pickFile(page, input, upload(original));
  await settings.getByRole("button", { name: "Allow access" }).click();
  await pickFile(page, input, upload(expanded));
  const review = settings.getByRole("group", { name: "Update Draft toolkit" });
  await expect(review).toContainText("Modify the current document at the selection");
  await expect(review).not.toContainText("Read the current document");
  await review.getByRole("button", { name: "Keep current version" }).click();
  await close.click();
  await page.getByRole("button", { name: "Draft metrics" }).click();
  await expect(page.getByRole("dialog", { name: "Draft metrics" })).toContainText("Words: 1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await expect(page.getByRole("option", { name: /Review marker/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await pickFile(page, input, upload(expanded));
  await review.getByRole("button", { name: "Allow and update" }).click();
  await close.click();
  await page.getByRole("button", { name: "Draft toolkit" }).click();
  await expect(page.getByRole("dialog", { name: "Draft toolkit" })).toContainText("Words: 1");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox").fill("Review marker");
  await expect(page.getByRole("option", { name: /Review marker/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor).toBeFocused();
  await expect(editor).toContainText("draft");
  await expect(editor).toContainText("REVIEW");
  await expect(page.locator(".cm-content").filter({ hasText: "another open draft" })).toHaveText(
    "another open draft",
  );
});

test("an installed package exports its own format from the current draft", async ({ page }) => {
  const manifest = {
    apiVersion: 1,
    id: "example.transcript",
    name: "Transcript exchange",
    permissions: ["document.read"],
    exportFormat: {
      label: "Transcript JSON",
      extension: "transcript",
      template: '{"title":{{json.title}},"body":{{json.text}}}',
    },
  };
  await launch(page, {
    locale: "en-US",
    files: {
      "/notes/report.md": "Saved draft",
      "/packages/transcript.json": JSON.stringify(manifest),
      [settingsPath]: '{"autosave":false}',
    },
    openDialogResults: ["/notes/report.md"],
    fileDialogResults: ["/packages/transcript.json"],
    saveDialogResults: ["/notes/share.transcript"],
  });
  await page.keyboard.press("ControlOrMeta+O");
  const body = 'Line one\n"Unpublished"';
  await page.getByRole("textbox").fill(body);
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Install a MINT plugin file" }).click({ timeout: 2500 });
  await page.getByRole("button", { name: "Allow access" }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await runMenuItem(page, "file.export");
  const dialog = page.getByRole("dialog", { name: "Import / Export" });
  await dialog.getByLabel("Format").selectOption({ label: "Transcript JSON" });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await savedDialogs(page)).toEqual(["/notes/report.transcript"]);
  expect(JSON.parse((await readFile(page, "/notes/share.transcript")) ?? "")).toEqual({
    title: "report",
    body,
  });
});
