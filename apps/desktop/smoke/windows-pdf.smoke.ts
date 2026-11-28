// Run against a production-asset MINT binary on the Windows CI runner. CDP
// observes the installed Edge WebView2 runtime. MINT's Rust backend writes the PDF.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { fieldNotes, verifyFieldNotes } from "../e2e/pdf-proof.ts";

const exec = promisify(execFile);
test("WebView2 saves the previewed A5 pages with the chosen margins and embedded image", {
  timeout: 120_000,
}, async () => {
  const dir = process.env.MINT_PDF_PROOF ?? (await mkdtemp(join(tmpdir(), "mint-webview2-pdf-")));
  await mkdir(dir, { recursive: true });
  const source = join(dir, "field.md");
  const target = join(dir, "field.pdf");
  await writeFile(source, fieldNotes);
  await writeFile(
    join(dir, "chart.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const app = spawn(resolve("src-tauri/target/debug/mint.exe"), [source], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: join(dir, "profile"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=4949",
    },
    stdio: "inherit",
  });
  const native = (action: string) =>
    exec("powershell.exe", [
      "-NoProfile",
      "-File",
      resolve("smoke/windows-pdf.ps1"),
      "-AppProcess",
      String(app.pid),
      "-Action",
      action,
    ]);
  try {
    const endpoint = "http://127.0.0.1:4949";
    await expect
      .poll(async () => (await fetch(`${endpoint}/json/version`).catch(() => null))?.ok, {
        timeout: 30_000,
      })
      .toBe(true);
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    assert.ok(context);
    await expect
      .poll(() => context.pages().some((p) => p.url().includes("tauri.localhost")), {
        timeout: 30_000,
      })
      .toBe(true);
    const page = context.pages().find((p) => p.url().includes("tauri.localhost"));
    assert.ok(page);
    await expect(page.locator(".cm-content")).toContainText("Field notes");
    await native("Export");
    const dialog = page.getByRole("dialog", { name: "Export as PDF" });
    await dialog.getByLabel("Paper size").selectOption("A5");
    await dialog.getByLabel("Margins (mm)").fill("22");
    await dialog.getByLabel("Font size (pt)").fill("16");
    const pages = dialog.frameLocator('iframe[title="Page preview"]').locator(".mint-sheet");
    await expect(pages.last()).toContainText("Observation-450", { timeout: 30_000 });
    const save = dialog.getByRole("button", { name: "Save PDF…" });
    await expect(save).toBeEnabled();
    const expected = await pages.allInnerTexts();
    assert.ok(expected.length > 1);
    await writeFile(join(dir, "preview.json"), JSON.stringify(expected, null, 2));
    await save.click();
    await native("Save");
    await expect
      .poll(
        async () => {
          const data = await readFile(target).catch(() => null);
          return data?.subarray(-32).includes("%%EOF") ?? false;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await verifyFieldNotes(await readFile(target), expected);
    assert.equal(await readFile(source, "utf8"), fieldNotes);
    console.log(`Verified ${expected.length} A5 pages from WebView2 at ${target}`);
  } finally {
    if (app.pid && app.exitCode === null)
      await exec("taskkill.exe", ["/pid", String(app.pid), "/t", "/f"]).catch(() => undefined);
  }
});
