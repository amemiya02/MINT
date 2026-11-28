// Run against a production-asset MINT binary on the Windows CI runner.
// The acceptance observer records the real preview. MINT's Rust backend writes the PDF.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
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
    },
    stdio: "inherit",
  });
  app.on("exit", (code, signal) => console.log(`MINT exited with code ${code}, signal ${signal}`));
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
    const readProof = async (name: string) => {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const failure = await readFile(join(dir, "error.json"), "utf8").catch(() => null);
        assert.equal(failure, null);
        const data = await readFile(join(dir, name), "utf8").catch(() => null);
        if (data !== null) return JSON.parse(data);
        assert.equal(app.exitCode, null, "MINT exited before completing the preview");
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(`MINT did not write ${name}`);
    };
    assert.equal(await readProof("ready.json"), true);
    await native("Export");
    const expected = await readProof("preview.json");
    assert.ok(Array.isArray(expected) && expected.length > 1);
    console.log((await native("Save")).stdout.trim());
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
  } catch (error) {
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-Process mint,msedgewebview2 -ErrorAction SilentlyContinue | Format-Table Id,Name,SessionId,MainWindowTitle | Out-String",
    ]).catch(() => ({ stdout: "" }));
    const files = await readdir(dir);
    const message = await readFile(join(dir, "error.json"), "utf8").catch(() => null);
    console.error(`Proof files: ${files.join(", ")}; application error: ${message}`);
    console.error(`MINT exit code ${app.exitCode}; native processes:\n${stdout}`);
    throw error;
  } finally {
    if (app.pid && app.exitCode === null)
      await exec("taskkill.exe", ["/pid", String(app.pid), "/t", "/f"]).catch(() => undefined);
  }
});
