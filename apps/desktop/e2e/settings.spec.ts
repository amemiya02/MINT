import { expect, test } from "@playwright/test";
import { launch, readFile, settingsPath, writeFile } from "./memory-platform.ts";

test("the interface language follows the system by default", async ({ page }) => {
  await launch(page, { locale: "zh-CN" });

  await expect(page.getByText("没有打开的文档")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await expect(page.getByLabel("界面语言")).toHaveValue("system");
});

test("changing the language in the settings window applies it and writes settings.json", async ({
  page,
}) => {
  await launch(page, { locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("Interface language").selectOption({ label: "简体中文" });

  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await expect(page.getByText("没有打开的文档")).toBeVisible();
  expect(JSON.parse((await readFile(page, settingsPath)) ?? "")).toEqual({ language: "zh-CN" });

  await page.getByLabel("界面语言").selectOption({ label: "跟随系统" });
  await expect(page.getByText("No document open")).toBeVisible();
});

test("settings.json is applied at startup", async ({ page }) => {
  await launch(page, { locale: "zh-CN", files: { [settingsPath]: '{ "language": "en" }' } });

  await expect(page.getByText("No document open")).toBeVisible();
});

test("editing settings.json from outside takes effect immediately, also in the open settings window", async ({
  page,
}) => {
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+,");

  await writeFile(page, settingsPath, '{\n  "language": "zh-CN"\n}\n');

  await expect(page.getByText("没有打开的文档")).toBeVisible();
  await expect(page.getByLabel("界面语言")).toHaveValue("zh-CN");
});

test("a settings.json that is not valid JSON is reported and the last valid settings stay in use", async ({
  page,
}) => {
  await launch(page, { locale: "en-US", files: { [settingsPath]: '{ "language": "zh-CN" }' } });
  await expect(page.getByText("没有打开的文档")).toBeVisible();

  await writeFile(page, settingsPath, '{ "language": "en", }');

  await expect(page.getByRole("alert")).toContainText("settings.json");
  await expect(page.getByRole("alert")).toContainText("上一次的有效设置");
  await expect(page.getByText("没有打开的文档")).toBeVisible();

  await writeFile(page, settingsPath, '{ "language": "en" }');
  await expect(page.getByText("No document open")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an invalid value is reported by name and that setting keeps its previous value", async ({
  page,
}) => {
  await launch(page, { locale: "en-US", files: { [settingsPath]: '{ "language": "zh-CN" }' } });
  await expect(page.getByText("没有打开的文档")).toBeVisible();

  await writeFile(page, settingsPath, '{ "language": "klingon", "colour": "red" }');

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("language");
  await expect(alert).toContainText('"system", "zh-CN", "en"');
  await expect(alert).toContainText("colour");
  await expect(page.getByText("没有打开的文档")).toBeVisible();
});

test("changing a setting in the window keeps entries it does not know about", async ({ page }) => {
  await launch(page, {
    locale: "en-US",
    files: { [settingsPath]: '{ "fromNewerVersion": { "a": 1 }, "language": "en" }' },
  });

  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("Interface language").selectOption("zh-CN");

  await expect(page.getByText("没有打开的文档")).toBeVisible();
  expect(JSON.parse((await readFile(page, settingsPath)) ?? "")).toEqual({
    fromNewerVersion: { a: 1 },
    language: "zh-CN",
  });
});

test("settings.json can be opened as a document, and saving it applies the change", async ({
  page,
}) => {
  await launch(page, { locale: "en-US", files: { [settingsPath]: '{ "language": "en" }' } });

  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: "Open settings.json" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toContainText('"language": "en"');

  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type('{ "language": "zh-CN" }');
  await page.keyboard.press("ControlOrMeta+S");

  await expect(page.getByText("已保存")).toBeVisible();
});
