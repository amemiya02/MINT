import { expect, test } from "@playwright/test";
import { launch } from "./memory-platform.ts";

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
  const input = settings.getByLabel("Install a MINT plugin file");
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
  await input.setInputFiles(file({ ...manifest, permissions: ["folder.read"] }));
  await expect(settings.getByRole("alert")).toContainText("Unsupported plugin package");
  await input.setInputFiles(file(manifest));
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
