import { expect, type Page, test } from "@playwright/test";
import {
  externalWrite,
  launch,
  readFile,
  settingsPath,
  themesPath,
  writeFile,
} from "./memory-platform.ts";

// The built-in themes' page backgrounds (docs/themes.md).
const lightBackground = "rgb(253, 253, 252)";
const darkBackground = "rgb(28, 30, 33)";

const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test("the built-in theme follows the system between light and dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await launch(page, { locale: "en-US" });
  await expect.poll(() => background(page)).toBe(darkBackground);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => background(page)).toBe(lightBackground);
});

test("light or dark can be pinned in the settings window, whatever the system uses", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await launch(page, { locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("Appearance").selectOption({ label: "Light" });
  await expect.poll(() => background(page)).toBe(lightBackground);

  await page.emulateMedia({ colorScheme: "light" });
  await page.getByLabel("Appearance").selectOption({ label: "Dark" });
  await expect.poll(() => background(page)).toBe(darkBackground);

  await page.getByLabel("Appearance").selectOption({ label: "Follow system" });
  await expect.poll(() => background(page)).toBe(lightBackground);
});

test("an appearance pinned in settings.json applies at startup", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await launch(page, { files: { [settingsPath]: '{ "appearance": "dark" }' } });
  await expect.poll(() => background(page)).toBe(darkBackground);

  await writeFile(page, settingsPath, '{ "appearance": "system" }');
  await expect.poll(() => background(page)).toBe(lightBackground);
});

const paper = (bg: string) => `:root { --mint-bg: ${bg}; }`;

test("a .css file in the theme folder can be chosen as the theme", async ({ page }) => {
  await launch(page, {
    locale: "en-US",
    files: { [`${themesPath}/paper.css`]: paper("rgb(250, 240, 220)") },
  });
  await expect.poll(() => background(page)).toBe(lightBackground);

  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByText(themesPath)).toBeVisible();
  await page.getByLabel("Theme").selectOption({ label: "paper" });

  await expect.poll(() => background(page)).toBe("rgb(250, 240, 220)");
  expect(JSON.parse((await readFile(page, settingsPath)) ?? "")).toEqual({ theme: "paper" });

  await page.getByLabel("Theme").selectOption({ label: "MINT (built-in)" });
  await expect.poll(() => background(page)).toBe(lightBackground);
});

test("editing the theme in use reloads it at once", async ({ page }) => {
  await launch(page, {
    files: {
      [settingsPath]: '{ "theme": "paper" }',
      [`${themesPath}/paper.css`]: paper("rgb(250, 240, 220)"),
    },
  });
  await expect.poll(() => background(page)).toBe("rgb(250, 240, 220)");

  await externalWrite(page, `${themesPath}/paper.css`, paper("rgb(10, 20, 30)"));

  await expect.poll(() => background(page)).toBe("rgb(10, 20, 30)");
});

test("a theme dropped into the folder shows up in the settings window without a restart", async ({
  page,
}) => {
  await launch(page, { locale: "en-US" });
  await page.keyboard.press("ControlOrMeta+,");

  await externalWrite(page, `${themesPath}/night.css`, paper("rgb(0, 0, 40)"));
  await expect(page.getByLabel("Theme").getByRole("option", { name: "night" })).toBeAttached();

  await page.getByLabel("Theme").selectOption({ label: "night" });
  await expect.poll(() => background(page)).toBe("rgb(0, 0, 40)");
});

test("a theme can give its own colors for each appearance", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await launch(page, {
    files: {
      [settingsPath]: '{ "theme": "duo" }',
      [`${themesPath}/duo.css`]: `${paper("rgb(1, 1, 1)")}
:root[data-appearance="dark"] { --mint-bg: rgb(2, 2, 2); }`,
    },
  });
  await expect.poll(() => background(page)).toBe("rgb(1, 1, 1)");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => background(page)).toBe("rgb(2, 2, 2)");
});

test("a chosen theme that is missing is reported, the built-in theme is used, and it applies once it appears", async ({
  page,
}) => {
  await launch(page, { locale: "en-US", files: { [settingsPath]: '{ "theme": "gone" }' } });

  await expect(page.getByRole("alert")).toContainText("“gone” was not found");
  await expect.poll(() => background(page)).toBe(lightBackground);

  await externalWrite(page, `${themesPath}/gone.css`, paper("rgb(5, 6, 7)"));
  await expect.poll(() => background(page)).toBe("rgb(5, 6, 7)");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("font, size, line height and content width apply to the document and override the theme", async ({
  page,
}) => {
  await launch(page, {
    locale: "en-US",
    files: {
      "/notes/a.md": "# Hello",
      [settingsPath]: '{ "theme": "big" }',
      [`${themesPath}/big.css`]: ":root { --mint-font-size: 30px; }",
    },
    openDialogResults: ["/notes/a.md"],
  });
  await page.keyboard.press("ControlOrMeta+O");
  const content = page.locator(".cm-content");
  await expect(content).toContainText("Hello");
  // Settings win over the theme, even at their defaults.
  await expect(content).toHaveCSS("font-size", "15px");

  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("Font size (px)").fill("20");
  await page.getByLabel("Line height").fill("2");
  await page.getByLabel("Content width (px)").fill("600");
  await page.getByLabel("Font", { exact: true }).fill("Georgia, serif");
  await page.getByLabel("Font", { exact: true }).press("Enter");

  await expect(content).toHaveCSS("font-size", "20px");
  await expect(content).toHaveCSS("line-height", "40px");
  await expect(content).toHaveCSS("max-width", "600px");
  await expect(content).toHaveCSS("font-family", "Georgia, serif");
  expect(JSON.parse((await readFile(page, settingsPath)) ?? "")).toMatchObject({
    fontSize: 20,
    lineHeight: 2,
    contentWidth: 600,
    fontFamily: "Georgia, serif",
  });
});
