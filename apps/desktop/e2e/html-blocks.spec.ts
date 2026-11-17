import { expect, test } from "@playwright/test";
import { launch, readFile } from "./memory-platform.ts";

/** A 1×1 PNG. */
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const path = "/repo/README.md";
const readme = [
  '<p align="center">',
  '<img alt="banner" src="docs/graphics/logos/banner_readme.png"/>',
  "</p>",
  "",
  '<a href="https://github.com/x/y/releases"><img src="https://img.shields.io/github/v/release/x/y" alt="release"/></a>',
  '<a href="https://ci.example/y"><img src="https://img.shields.io/badge/build-ok-green" alt="build"/></a>',
  "",
  "<script>window.pwned = true</script>",
  "",
  "# Project",
  "",
].join("\r\n");

test("a README's HTML banner and badges render, reveal on click and save unchanged", async ({
  page,
}) => {
  await page.route("https://img.shields.io/**", (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(pngBase64, "base64") }),
  );
  await launch(page, {
    files: { [path]: readme },
    binaryFiles: { "/repo/docs/graphics/logos/banner_readme.png": pngBase64 },
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  const content = page.locator(".cm-content");
  await expect(content).toContainText("Project");
  // The cursor below everything, so every block renders.
  await page.keyboard.press("ControlOrMeta+End");

  for (const alt of ["banner", "release", "build"]) {
    await expect
      .poll(() =>
        page
          .locator(`.cm-mint-html img[alt="${alt}"]`)
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
  }
  await expect(page.locator('.cm-mint-html p[align="center"]')).toHaveCount(1);
  await expect(content).not.toContainText("<img");
  expect(await page.evaluate(() => (window as { pwned?: boolean }).pwned)).toBeUndefined();

  // Clicking the banner reveals its source.
  await page.locator('.cm-mint-html img[alt="banner"]').click();
  await expect(content).toContainText('<p align="center">');
  await expect(content).toContainText("banner_readme.png");

  await page.keyboard.press("ControlOrMeta+S");
  expect(await readFile(page, path)).toBe(readme);
});
