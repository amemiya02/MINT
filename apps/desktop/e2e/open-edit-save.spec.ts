import { expect, test } from "@playwright/test";
import type { MemoryPlatform } from "../src/platform/memory.ts";
import { launch, readFile, settingsPath } from "./memory-platform.ts";

const path = "/notes/todo.md";
// A BOM, CRLF line endings and a final newline: all must survive a save.
const original = "﻿# Todo\r\n\r\n- milk\r\n";

test("open a document, edit it and save it", async ({ page }) => {
  await launch(page, { files: { [path]: original }, openDialogResults: [path], locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+O");
  const editor = page.getByRole("textbox");
  await expect(editor).toContainText("milk");
  await expect(page).toHaveTitle("todo.md — MINT");

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("- eggs");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await readFile(page, path)).toBe("﻿# Todo\r\n\r\n- milk\r\n- eggs");
});

test("saving an unedited document leaves the file byte-for-byte unchanged", async ({ page }) => {
  await launch(page, { files: { [path]: original }, openDialogResults: [path], locale: "en-US" });

  await page.getByRole("button", { name: "Open Document…" }).click();
  await expect(page.getByRole("textbox")).toContainText("# Todo");
  await page.keyboard.press("ControlOrMeta+S");

  expect(await readFile(page, path)).toBe(original);
});

test("shows the interface in Chinese when the system language is Chinese", async ({ page }) => {
  await launch(page, { files: {}, locale: "zh-CN" });

  await expect(page.getByText("没有打开的文档")).toBeVisible();
  await expect(page.getByRole("button", { name: "打开文档…" })).toBeVisible();
});

test("reports a document that cannot be opened", async ({ page }) => {
  await launch(page, { files: {}, openDialogResults: ["/missing.md"], locale: "en-US" });

  await page.keyboard.press("ControlOrMeta+O");
  await expect(page.getByRole("alert")).toContainText("Could not open /missing.md");
});

for (const firstCommand of ["Save", "Save As"] as const) {
  test(`a Save queued behind ${firstCommand} preserves write order and leaves later edits dirty`, async ({
    page,
  }) => {
    const dest = firstCommand === "Save As" ? "/notes/new.md" : path;
    await launch(page, {
      files: { [path]: "a", [settingsPath]: JSON.stringify({ autosave: false }) },
      openDialogResults: [path],
      saveDialogResults: [dest],
      locale: "en-US",
    });
    await page.keyboard.press("ControlOrMeta+O");
    await expect(page.getByRole("textbox")).toContainText("a");
    await page.keyboard.press("ControlOrMeta+End");

    // Hold the first filesystem write open until both save commands have been issued.
    const gate = await page.evaluateHandle(() => {
      const platform = (window as unknown as { __MINT_MEMORY_PLATFORM__: MemoryPlatform })
        .__MINT_MEMORY_PLATFORM__;
      const write = platform.writeTextFile;
      let notifyStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      platform.writeTextFile = async (file, text) => {
        platform.writeTextFile = write;
        notifyStarted();
        await held;
        await write(file, text);
      };
      return { started, release };
    });
    await page.keyboard.type("b");
    await page.keyboard.press(
      firstCommand === "Save As" ? "ControlOrMeta+Shift+S" : "ControlOrMeta+S",
    );
    await gate.evaluate((g) => g.started);
    await page.keyboard.type("c");
    await page.keyboard.press("ControlOrMeta+S");
    await page.keyboard.type("d");
    await gate.evaluate((g) => g.release());
    await expect.poll(() => readFile(page, dest)).toBe("abc");
    if (dest !== path) expect(await readFile(page, path)).toBe("a");
    await expect(page.getByRole("textbox")).toContainText("abcd");
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+S");
    await expect.poll(() => readFile(page, dest)).toBe("abcd");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  });
}
