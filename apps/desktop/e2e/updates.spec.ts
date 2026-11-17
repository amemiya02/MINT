import { expect, test } from "@playwright/test";
import { launch, runMenuItem, settingsPath, updatesInstalled } from "./memory-platform.ts";

test("a new version found at startup is offered and installed on request", async ({ page }) => {
  await launch(page, { locale: "en-US", update: { version: "0.2.0" } });

  const notice = page.getByRole("status");
  await expect(notice).toContainText("MINT 0.2.0 is available");
  await notice.getByRole("button", { name: "Install and Restart" }).click();

  await expect.poll(() => updatesInstalled(page)).toEqual(["0.2.0"]);
});

test("a new version can be postponed", async ({ page }) => {
  await launch(page, { locale: "en-US", update: { version: "0.2.0" } });

  await page.getByRole("status").getByRole("button", { name: "Later" }).click();

  await expect(page.getByRole("status")).toHaveCount(0);
  expect(await updatesInstalled(page)).toEqual([]);
});

test("only the first window checks at startup", async ({ page }) => {
  await launch(page, { locale: "en-US", update: { version: "0.2.0" } });
  await expect(page.getByRole("status")).toContainText("MINT 0.2.0 is available");

  const [second] = await Promise.all([
    page.waitForEvent("popup"),
    page.keyboard.press("ControlOrMeta+Shift+N"),
  ]);

  await expect(second.getByText("No document open")).toBeVisible();
  await expect(second.getByRole("status")).toHaveCount(0);
});

test("nothing is shown at startup when MINT is up to date", async ({ page }) => {
  await launch(page, { locale: "en-US" });

  await expect(page.getByText("No document open")).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("the startup check can be turned off in settings.json", async ({ page }) => {
  await launch(page, {
    locale: "en-US",
    update: { version: "0.2.0" },
    files: { [settingsPath]: '{ "checkForUpdates": false }' },
  });

  await expect(page.getByText("No document open")).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("checking by hand says when MINT is up to date", async ({ page }) => {
  await launch(page, { locale: "en-US" });

  await runMenuItem(page, "app.checkForUpdates");

  await expect(page.getByRole("status")).toContainText("MINT is up to date");
});

test("checking by hand finds a new version even with the startup check turned off", async ({
  page,
}) => {
  await launch(page, {
    locale: "zh-CN",
    update: { version: "0.2.0" },
    files: { [settingsPath]: '{ "checkForUpdates": false }' },
  });
  await expect(page.getByText("没有打开的文档")).toBeVisible();

  await runMenuItem(page, "app.checkForUpdates");

  await expect(page.getByRole("status")).toContainText("MINT 0.2.0");
});

test("a failed check by hand is reported, a failed startup check is not", async ({ page }) => {
  await launch(page, { locale: "en-US", update: { error: "network unreachable" } });
  await expect(page.getByText("No document open")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await runMenuItem(page, "app.checkForUpdates");

  await expect(page.getByRole("alert")).toContainText("Could not check for updates");
  await expect(page.getByRole("alert")).toContainText("network unreachable");
});

test("checking by hand where updates are not available says so", async ({ page }) => {
  await launch(page, { locale: "en-US", update: "unavailable" });

  await runMenuItem(page, "app.checkForUpdates");

  await expect(page.getByRole("status")).toContainText("not available");
});

test("a failed installation is reported", async ({ page }) => {
  await launch(page, {
    locale: "en-US",
    update: { version: "0.2.0", installError: "signature mismatch" },
  });

  await page.getByRole("button", { name: "Install and Restart" }).click();

  await expect(page.getByRole("alert")).toContainText("Could not install MINT 0.2.0");
  await expect(page.getByRole("alert")).toContainText("signature mismatch");
});
