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
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const driver = process.env.TAURI_DRIVER_URL ?? "http://127.0.0.1:4444";
const application = process.env.MINT_APP;

/** WebDriver's key codes (https://w3c.github.io/webdriver/#keyboard-actions). */
const keys = {
  control: "\uE009",
  end: "\uE010",
  home: "\uE011",
  shift: "\uE008",
  enter: "\uE007",
} as const;
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

type KeyAction = { type: "keyDown" | "keyUp"; value: string };
const typing = (text: string): KeyAction[] =>
  [...text].flatMap((value) => [
    { type: "keyDown", value },
    { type: "keyUp", value },
  ]);
/** Hold `modifier` while pressing `key`. */
const chord = (modifier: string, key: string): KeyAction[] => [
  { type: "keyDown", value: modifier },
  ...typing(key),
  { type: "keyUp", value: modifier },
];
async function keyActions(actions: KeyAction[]): Promise<void> {
  await command("POST", `/session/${session}/actions`, {
    actions: [{ type: "key", id: "keyboard", actions }],
  });
  await command("DELETE", `/session/${session}/actions`);
}

const exec = promisify(execFile);

/** WebDriver's keyboard targets the webview. Native menu accelerators belong to its GTK window. */
async function nativeShortcut(chord: string) {
  await exec("xdotool", ["search", "--onlyvisible", "--name", "MINT$", "windowfocus", "--sync"]);
  await exec("xdotool", ["key", chord]);
}

/** Fail with what the window shows, which says which step went missing. */
async function explain(e: unknown): Promise<never> {
  const page = await command<string>("POST", `/session/${session}/execute/sync`, {
    script:
      'return document.body.innerText + "\\n(focus: " + document.activeElement?.className + ")"',
    args: [],
  }).catch((err: unknown) => `(cannot read the page: ${String(err)})`);
  throw new Error(`${String(e)}\n--- the window shows ---\n${page}`);
}

let dir = "";
let document = "";
let session = "";

before(async () => {
  assert.ok(application, "set MINT_APP to the built MINT binary");
  dir = await mkdtemp(join(tmpdir(), "mint-smoke-"));
  document = join(dir, "smoke.md");
  await writeFile(document, "\uFEFF# Smoke\r\n\r\nfirst line  ");
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
  // Key actions go to the focused element, as real key presses do.
  await keyActions([...chord(keys.control, keys.end), ...typing(`${keys.enter}second line`)]);
  await until(
    "the edit to show",
    async () => {
      const text = await command<string>("GET", `/session/${session}/element/${editor}/text`);
      return text.includes("second line") ? text : null;
    },
    10_000,
  ).catch(explain);
  await nativeShortcut("ctrl+s");

  const saved = await until("the document to be saved", async () => {
    const text = await readFile(document, "utf8");
    return text.includes("second line") ? text : null;
  }).catch(explain);
  assert.equal(saved, "\uFEFF# Smoke\r\n\r\nfirst line  \r\nsecond line");

  await keyActions(chord(keys.shift, keys.home));
  await nativeShortcut("ctrl+k");
  await until("the selected text to become a link", async () => {
    const text = await command<string>("GET", `/session/${session}/element/${editor}/text`);
    return text.includes("[second line]()") || null;
  }).catch(explain);
  await keyActions(typing("#smoke"));
  await nativeShortcut("ctrl+s");
  const linked = await until("the standard Markdown link on disk", async () => {
    const bytes = await readFile(document);
    return bytes.includes(Buffer.from("[second line](#smoke)")) ? bytes : null;
  }).catch(explain);
  assert.deepEqual(
    linked,
    Buffer.from("\uFEFF# Smoke\r\n\r\nfirst line  \r\n[second line](#smoke)"),
  );

  const split = await command<Record<string, string>>("POST", `/session/${session}/element`, {
    using: "css selector",
    value: 'button[aria-label="Open smoke.md in other pane"]',
  });
  await command("POST", `/session/${session}/element/${split[elementKey]}/click`, {});
  const waitForFocusedPane = (count: number) =>
    until(`the last of ${count} editors to receive focus`, async () => {
      const ready = await command<boolean>("POST", `/session/${session}/execute/sync`, {
        script:
          "const editors = document.querySelectorAll('.cm-content'); return editors.length === arguments[0] && editors[editors.length - 1] === document.activeElement",
        args: [count],
      });
      return ready || null;
    }).catch(explain);
  await waitForFocusedPane(2);
  await keyActions([...chord(keys.control, keys.end), ...typing("!")]);
  await nativeShortcut("ctrl+s");
  await until(
    "the second view to save the original document",
    async () =>
      (await readFile(document)).equals(Buffer.concat([linked, Buffer.from("!")])) || null,
  ).catch(explain);
  await nativeShortcut("ctrl+w");
  await waitForFocusedPane(1);
  await keyActions(chord(keys.control, "z"));
  await nativeShortcut("ctrl+s");
  await until(
    "the first view to undo the edit and restore the original bytes",
    async () => (await readFile(document)).equals(linked) || null,
  ).catch(explain);
});

test("saved versions survive a native restart outside the working folder", async () => {
  await command("DELETE", `/session/${session}`);
  session = "";
  const created = await command<{ sessionId: string }>("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application, args: [document] } } },
  });
  session = created.sessionId;
  const clickHistory = await until("version history button", async () => {
    const item = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "css selector",
      value: 'footer button[aria-label="Version History"]',
    });
    return item[elementKey] ?? null;
  });
  await command("POST", `/session/${session}/element/${clickHistory}/click`, {});
  await until(
    "the saved text to appear in a comparison",
    async () =>
      (await command<boolean>("POST", `/session/${session}/execute/sync`, {
        script: `const dialog = document.querySelector('dialog[open]');
        return dialog?.querySelector('select')?.options.length >= 3 &&
          dialog.querySelector('pre')?.textContent.includes('second line') === true;`,
        args: [],
      })) || null,
  ).catch(explain);
  assert.deepEqual(await readdir(dir), ["smoke.md"]);
  await keyActions(typing("\uE00C"));
});

test("the native statistics view refuses a denied read and allows an explicit grant", async () => {
  const click = async (label: string) => {
    const element = await until(label, async () => {
      const result = await command<Record<string, string>>("POST", `/session/${session}/element`, {
        using: "xpath",
        value: `//button[normalize-space(.)='${label}']`,
      });
      return result[elementKey] ?? null;
    }).catch(explain);
    await command("POST", `/session/${session}/element/${element}/click`, {});
  };
  const shows = (text: string) =>
    until(text, () =>
      command<boolean>("POST", `/session/${session}/execute/sync`, {
        script:
          "return document.querySelector('dialog[open]')?.innerText.includes(arguments[0]) === true",
        args: [text],
      }).then((found) => (found ? true : null)),
    ).catch(explain);

  await nativeShortcut("ctrl+n");
  await until("the new document to receive focus", async () => {
    const ready = await command<boolean>("POST", `/session/${session}/execute/sync`, {
      script:
        "return document.activeElement?.matches('.cm-content') && document.activeElement.textContent === ''",
      args: [],
    });
    return ready ? true : null;
  }).catch(explain);
  await keyActions(typing("a native draft"));
  await nativeShortcut("ctrl+comma");
  await click("Install");
  await shows("Read the current document");
  await click("Deny access");
  await click("Close");
  await click("Writing statistics");
  await shows("Permission to read the current document was denied.");
  await click("Close");
  await nativeShortcut("ctrl+comma");
  await click("Allow access");
  await click("Close");
  await click("Writing statistics");
  await shows("Words: 3");
  await click("Close");
  await nativeShortcut("ctrl+comma");
  await click("Uninstall");
  await click("Close");
});
