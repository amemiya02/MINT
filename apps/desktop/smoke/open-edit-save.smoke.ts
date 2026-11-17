// Smoke test of the real desktop app (Tauri + system webview + Rust backend),
// driven over WebDriver by tauri-driver. Runs on Linux CI only (WebKitGTK's
// WebKitWebDriver; tauri-driver does not support macOS):
//
//   tauri-driver &                                   # listens on :4444
//   MINT_APP=src-tauri/target/debug/mint xvfb-run node --test smoke/*.smoke.ts
//
// The document is handed to MINT on the command line, as a file manager does,
// so no native dialog is involved.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const driver = process.env.TAURI_DRIVER_URL ?? "http://127.0.0.1:4444";
const application = process.env.MINT_APP;

/** WebDriver's key codes (https://w3c.github.io/webdriver/#keyboard-actions). */
const keys = { control: "\uE009", end: "\uE010", enter: "\uE007", release: "\uE000" } as const;
/** The element reference key of the WebDriver protocol. */
const elementKey = "element-6066-11e4-a52e-4f735466cecf";

async function command<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${driver}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json()) as { value: T };
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
  return json.value;
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (e) {
      last = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

let dir = "";
let document = "";
let session = "";

before(async () => {
  assert.ok(application, "set MINT_APP to the built MINT binary");
  dir = await mkdtemp(join(tmpdir(), "mint-smoke-"));
  document = join(dir, "smoke.md");
  await writeFile(document, "# Smoke\n\nfirst line");
  const created = await command<{ sessionId: string }>("POST", "/session", {
    capabilities: {
      alwaysMatch: { "tauri:options": { application, args: [document] } },
    },
  });
  session = created.sessionId;
});

after(async () => {
  if (session) await command("DELETE", `/session/${session}`).catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("a document opened from the command line can be edited and saved", async () => {
  const editor = await until("the editor to show the document", async () => {
    const found = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "css selector",
      value: ".cm-content",
    });
    const id = found[elementKey];
    if (!id) return null;
    const text = await command<string>("GET", `/session/${session}/element/${id}/text`);
    return text.includes("first line") ? id : null;
  });

  await command("POST", `/session/${session}/element/${editor}/click`, {});
  await command("POST", `/session/${session}/element/${editor}/value`, {
    text: `${keys.control}${keys.end}${keys.release}${keys.enter}second line`,
  });
  await command("POST", `/session/${session}/element/${editor}/value`, {
    text: `${keys.control}s${keys.release}`,
  });

  const saved = await until("the document to be saved", async () => {
    const text = await readFile(document, "utf8");
    return text.includes("second line") ? text : null;
  }).catch(async (e: unknown) => {
    // What the window shows says whether the edit or the save went missing.
    const page = await command<string>("POST", `/session/${session}/execute/sync`, {
      script: "return document.body.innerText",
      args: [],
    }).catch((err: unknown) => `(cannot read the page: ${String(err)})`);
    throw new Error(`${String(e)}\n--- the window shows ---\n${page}`);
  });
  assert.equal(saved, "# Smoke\n\nfirst line\nsecond line");
});
