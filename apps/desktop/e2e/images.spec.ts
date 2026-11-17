import { expect, type Page, test } from "@playwright/test";
import { launch, listPaths, readBinaryFile, readFile } from "./memory-platform.ts";

/** A 1×1 PNG. */
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const pngBytes = [...Buffer.from(pngBase64, "base64")];

async function openDocument(page: Page, path: string, text: string, binaryFiles = {}) {
  await launch(page, {
    files: { [path]: text },
    binaryFiles,
    openDialogResults: [path],
    locale: "en-US",
  });
  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.locator(".cm-content")).toBeVisible();
}

/** Whether the image with this alt text has loaded and has pixels. */
function loaded(page: Page, alt: string) {
  return page
    .locator(alt ? `.cm-content img[alt="${alt}"]` : ".cm-mint-image img")
    .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
}

/** Paste or drop files into the editor the way the browser delivers them. */
async function sendFiles(
  page: Page,
  type: "paste" | "drop",
  files: { name: string; mime: string }[],
) {
  await page.locator(".cm-content").evaluate(
    (content, { type, files, bytes }) => {
      const data = new DataTransfer();
      for (const f of files)
        data.items.add(new File([new Uint8Array(bytes)], f.name, { type: f.mime }));
      // Drop on the last line, as the user would drag files below the text.
      const last = content.querySelector(".cm-line:last-child")?.getBoundingClientRect();
      const point = last ? { clientX: last.left + 2, clientY: last.top + last.height / 2 } : {};
      const event =
        type === "paste"
          ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent("drop", {
              dataTransfer: data,
              bubbles: true,
              cancelable: true,
              ...point,
            });
      content.dispatchEvent(event);
    },
    { type, files, bytes: pngBytes },
  );
}

test("shows relative, absolute and web images, and a placeholder for a missing one", async ({
  page,
}) => {
  await page.route("https://img.example/**", (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.from(pngBase64, "base64") }),
  );
  await openDocument(
    page,
    "/notes/doc.md",
    "start\n\n![rel](img/a.png)\n\n![abs](/pics/b%20c.png)\n\nText ![web](https://img.example/c.png) inline\n\n![none](missing.png)\n",
    { "/notes/img/a.png": pngBase64, "/pics/b c.png": pngBase64 },
  );

  for (const alt of ["rel", "abs", "web"]) {
    await expect.poll(() => loaded(page, alt)).toBe(true);
  }
  await expect(page.locator(".cm-mint-image-missing")).toHaveText("none");
  await expect(page.locator(".cm-content")).not.toContainText("](");

  // Clicking an image puts the cursor on it, which shows its source.
  await page.locator('.cm-content img[alt="abs"]').click();
  await expect(page.locator(".cm-content")).toContainText("![abs](/pics/b%20c.png)");
});

test("a pasted image is saved to the asset folder and referenced relatively", async ({ page }) => {
  const path = "/notes/doc.md";
  await openDocument(page, path, "Shot: \n");
  await page.keyboard.press("End");

  await sendFiles(page, "paste", [{ name: "image.png", mime: "image/png" }]);

  // The cursor ends up right after the reference, so its source shows; elsewhere, the image does.
  await expect(page.locator(".cm-content")).toContainText("](assets/image-");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect.poll(() => loaded(page, "")).toBe(true);
  const saved = (await listPaths(page)).filter((p) => p.startsWith("/notes/assets/"));
  expect(saved).toEqual([expect.stringMatching(/^\/notes\/assets\/image-\d{8}-\d{6}\.png$/)]);
  const asset = saved[0] ?? "";
  expect(await readBinaryFile(page, asset)).toEqual(pngBytes);

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const name = asset.slice("/notes/assets/".length);
  const stem = name.slice(0, -".png".length);
  expect(await readFile(page, path)).toBe(`Shot: ![${stem}](assets/${name})\n`);
});

test("dropped image files are copied to the asset folder without overwriting", async ({ page }) => {
  const path = "/notes/doc.md";
  await openDocument(page, path, "Photos:\n", { "/notes/assets/cat.png": pngBase64 });
  await page.keyboard.press("ControlOrMeta+End");

  await sendFiles(page, "drop", [
    { name: "cat.png", mime: "image/png" },
    { name: "my dog.png", mime: "image/png" },
  ]);

  await expect(page.locator(".cm-mint-image img")).toHaveCount(2);
  expect((await listPaths(page)).filter((p) => p.startsWith("/notes/assets/"))).toEqual([
    "/notes/assets/cat-1.png",
    "/notes/assets/cat.png",
    "/notes/assets/my dog.png",
  ]);
  expect(await readBinaryFile(page, "/notes/assets/my dog.png")).toEqual(pngBytes);

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe(
    "Photos:\n![cat-1](assets/cat-1.png)\n![my dog](assets/my%20dog.png)",
  );
});
