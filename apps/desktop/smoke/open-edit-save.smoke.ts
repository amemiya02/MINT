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

async function restart(args: string[]) {
  await command("DELETE", `/session/${session}`);
  session = "";
  const created = await command<{ sessionId: string }>("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application, args } } },
  });
  session = created.sessionId;
}

test("saved versions survive a native restart outside the working folder", async () => {
  await restart([document]);
  const historyButton = await until("version history button", async () => {
    const item = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "css selector",
      value: 'footer button[aria-label="Version History"]',
    });
    return item[elementKey] ?? null;
  });
  // A new GTK menu can move the footer during startup. Activate the button by keyboard.
  await command("POST", `/session/${session}/element/${historyButton}/value`, { text: keys.enter });
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

test("history restores and undo autosave the exact native file", async () => {
  const current = Buffer.from("\uFEFF# Smoke\r\n\r\nfirst line  \r\n[second line](#smoke)");
  const earlier = Buffer.from("\uFEFF# Smoke\r\n\r\nfirst line  \r\nsecond line");
  async function click(using: string, value: string) {
    const id = await until(value, async () => {
      const item = await command<Record<string, string>>("POST", `/session/${session}/element`, {
        using,
        value,
      });
      return item[elementKey] ?? null;
    }).catch(explain);
    await command("POST", `/session/${session}/element/${id}/click`, {});
  }
  for (const action of ["Restore this change", "Restore entire version"]) {
    await click("css selector", 'footer button[aria-label="Version History"]');
    await click("css selector", "dialog label:first-child select option:first-child");
    await click("css selector", 'dialog select option[value="0"]');
    await click("xpath", `//dialog//button[normalize-space(.)='${action}']`);
    await until(action, async () => (await readFile(document)).equals(earlier) || null).catch(
      explain,
    );
    await keyActions(chord(keys.control, "z"));
    await until(
      "undo to autosave",
      async () => (await readFile(document)).equals(current) || null,
    ).catch(explain);
  }
  assert.deepEqual(await readdir(dir), ["smoke.md"]);
});

test("moving a Kanban card changes only its status on disk after the writer grants access", async () => {
  assert.ok(application);
  const folder = await mkdtemp(join(dir, "kanban-"));
  const path = join(folder, "card.md");
  const draft = "\uFEFF---\r\nstatus: 'Draft'  # keep\r\n---\r\n\r\nNotes.  \r\n";
  await writeFile(path, draft);
  await restart([folder]);
  async function clickPath(xpath: string) {
    const id = await until(xpath, async () => {
      const el = await command<Record<string, string>>("POST", `/session/${session}/element`, {
        using: "xpath",
        value: xpath,
      });
      return el[elementKey] ?? null;
    }).catch(explain);
    await command("POST", `/session/${session}/element/${id}/click`, {});
  }
  await until("the Kanban fixture folder to open", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `return !!document.querySelector('[role=treeitem][aria-label="card.md"]')`,
      args: [],
    }).then((ready) => ready || null),
  ).catch(explain);
  await nativeShortcut("ctrl+comma");
  await clickPath("//fieldset[@aria-label='Kanban board']//button[normalize-space(.)='Install']");
  await shows("Change the status property");
  await click("Deny access");
  const grant = (action: string) =>
    `//fieldset[@aria-label='Kanban board']//small[contains(.,'${action}')]/following-sibling::button`;
  await clickPath(grant("Read Markdown"));
  await click("Close");
  await clickPath("//nav//button[@aria-label='Kanban board']");
  const select = "//aside//select[@aria-label='Move card.md']";
  await until("read-only Kanban card", async () => {
    const el = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "xpath",
      value: `${select}[@disabled]`,
    });
    return el[elementKey] ?? null;
  }).catch(explain);
  assert.equal(await readFile(path, "utf8"), draft);
  await nativeShortcut("ctrl+comma");
  await clickPath(grant("Change the status"));
  await click("Close");
  await clickPath(`${select}/option[@value='Done']`);
  await until(
    "the status update to reach disk",
    async () => (await readFile(path, "utf8")) === draft.replace("'Draft'", "'Done'") || null,
  ).catch(explain);
  await restart([folder]);
  await click("Kanban board", "aria-label");
  await clickPath("//aside//section[@aria-label='Done']//button[normalize-space(.)='card.md']");
  assert.deepEqual(await readdir(folder), ["card.md"]);
  await nativeShortcut("ctrl+comma");
  await clickPath("//fieldset[@aria-label='Kanban board']//button[normalize-space(.)='Uninstall']");
  await click("Close");
});

const click = async (label: string, by: "text" | "aria-label" = "text") => {
  const element = await until(label, async () => {
    const result = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "xpath",
      value: `//button[${by === "text" ? "normalize-space(.)" : "@aria-label"}='${label}']`,
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

test("the native statistics view refuses a denied read and allows an explicit grant", async () => {
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

test("declining a plugin update keeps its native read grant and withholds its write command", async () => {
  const original = {
    apiVersion: 1,
    id: "smoke.draft-tools",
    name: "Smoke metrics",
    permissions: ["document.read"],
    statistics: ["words"],
  };
  const expanded = {
    ...original,
    name: "Smoke toolkit",
    permissions: ["document.read", "document.write"],
    templates: [{ name: "Smoke marker", text: "SMOKE WRITE" }],
  };
  const upload = async (manifest: object) => {
    await until("plugin file chooser", () =>
      command<boolean>("POST", `/session/${session}/execute/sync`, {
        script: `const input = document.querySelector('dialog[open] input[type=file][accept*=json]');
          if (!input) return false;
          const transfer = new DataTransfer();
          transfer.items.add(new File([JSON.stringify(arguments[0])], 'smoke.mint.json', {type: 'application/json'}));
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', {bubbles: true}));
          return true;`,
        args: [manifest],
      }).then((ready) => ready || null),
    ).catch(explain);
  };
  await nativeShortcut("ctrl+n");
  await until("the new plugin update draft to receive focus", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script:
        "return document.activeElement?.matches('.cm-content') && !document.activeElement.textContent",
      args: [],
    }).then((ready) => ready || null),
  ).catch(explain);
  await keyActions(typing("plugin update draft"));
  await nativeShortcut("ctrl+comma");
  await upload(original);
  await click("Allow access");
  await upload(expanded);
  await shows("Modify the current document at the selection");
  await click("Keep current version");
  await click("Close");
  await click("Smoke metrics");
  await shows("Words: 3");
  await click("Close");
  await nativeShortcut("ctrl+shift+p");
  await keyActions(typing("Smoke marker"));
  await shows("No matching commands");
  await keyActions(typing("\uE00C"));
  await nativeShortcut("ctrl+comma");
  await upload(expanded);
  await click("Allow and update");
  await click("Close");
  await nativeShortcut("ctrl+shift+p");
  await keyActions(typing("Smoke marker"));
  await shows("Insert template · Smoke marker");
  await keyActions(typing(keys.enter));
  await until("the newly authorized write command to edit the native draft", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `const draft = document.querySelector('.cm-content:focus')?.innerText;
        return draft?.includes('plugin update draft') && draft.includes('SMOKE WRITE');`,
      args: [],
    }).then((written) => written || null),
  ).catch(explain);
  await nativeShortcut("ctrl+comma");
  await click("Uninstall");
  await click("Close");
});

test("recognizing and previewing a native folder's wikilinks preserves its files", async () => {
  assert.ok(application);
  const folder = await mkdtemp(join(dir, "wikilinks-"));
  const source = join(folder, "draft.md");
  const target = join(folder, "Report.md");
  const draft = Buffer.from("\uFEFF# Draft\r\n\r\nSee [[Report#Results|evidence]].  \r\n");
  const report = Buffer.from("# Report\n\n## Results\n\nA flock of herons.\n");
  await writeFile(source, draft);
  await writeFile(target, report);
  // The single-instance handler forwards both paths to the existing window.
  await exec(application, [folder, source], { timeout: 15_000 });
  await until("the folder and draft to open", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `return document.querySelector('[role=tab][aria-selected=true]')?.title === arguments[0] &&
        !!document.querySelector('[role=treeitem][aria-label="Report.md"]');`,
      args: [source],
    }).then((ready) => ready || null),
  ).catch(explain);
  const toggleSetting = async (enabled: boolean) => {
    await nativeShortcut("ctrl+comma");
    await shows(`Recognize wikilinks in ${folder}`);
    const settingsPath = await command<string>("POST", `/session/${session}/execute/sync`, {
      script: "return document.querySelector('dialog[open] span[title$=\"settings.json\"]')?.title",
      args: [],
    });
    const checkbox = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "xpath",
      value: `//input[@id=//label[normalize-space(.)='Recognize wikilinks in ${folder}']/@for]`,
    });
    await command("POST", `/session/${session}/element/${checkbox[elementKey]}/click`, {});
    await until(
      "the folder setting to reach disk",
      async () =>
        JSON.parse(await readFile(settingsPath, "utf8")).wikilinkFolders?.includes(folder) ===
          enabled || null,
    ).catch(explain);
    await click("Close");
  };
  await toggleSetting(true);
  // Place the caret on the visible alias and use the same Preview Link shortcut as the UI.
  const alias = await until("the wikilink label", async () => {
    const item = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "xpath",
      value: "//span[normalize-space(.)='evidence']",
    });
    return item[elementKey] ?? null;
  }).catch(explain);
  await command("POST", `/session/${session}/element/${alias}/click`, {});
  await nativeShortcut("ctrl+alt+Return");
  await shows("A flock of herons.");
  await click("Close");
  await toggleSetting(false);
  assert.deepEqual(await readFile(source), draft);
  assert.deepEqual(await readFile(target), report);
  assert.deepEqual((await readdir(folder)).sort(), ["Report.md", "draft.md"]);
});

test("reopen a bookmark after a native restart and remove it without touching the working folder", async () => {
  assert.ok(application);
  const folder = await mkdtemp(join(dir, "bookmarks-"));
  const path = join(folder, "reference.md");
  const original = Buffer.from("\uFEFF# Reference\r\n\r\nField notes.  \r\n");
  await writeFile(path, original);
  const checkFolder = async () => {
    assert.deepEqual(await readFile(path), original);
    assert.deepEqual(await readdir(folder), ["reference.md"]);
  };
  const waitForDocument = () =>
    until("the bookmarked manuscript to open", () =>
      command<boolean>("POST", `/session/${session}/execute/sync`, {
        script: `return document.querySelector('[role=tab][aria-selected=true]')?.title === arguments[0]
          && document.querySelector('[role=tabpanel]:not([hidden]) .cm-content')?.textContent.includes('Field notes.');`,
        args: [path],
      }).then((open) => open || null),
    ).catch(explain);
  const waitForBookmark = (present: boolean) =>
    until(present ? "bookmark added" : "bookmark removed", () =>
      command<boolean>("POST", `/session/${session}/execute/sync`, {
        script: `const panel = document.querySelector('aside[aria-label="Bookmarks"]');
          return !!panel && Array.from(panel.querySelectorAll('button')).some(
            button => button.getAttribute('aria-label') === arguments[0]) === arguments[1];`,
        args: [path, present],
      }).then((ready) => ready || null),
    ).catch(explain);

  await exec(application, [folder, path], { timeout: 15_000 });
  await until("the bookmarked document’s folder to open", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `return !!document.querySelector('[role="treeitem"][aria-label="reference.md"]');`,
      args: [],
    }).then((open) => open || null),
  ).catch(explain);
  await waitForDocument();
  await click("Bookmarks", "aria-label");
  await click("Bookmark current document");
  await waitForBookmark(true);
  await checkFolder();

  await restart([]);
  await click("Bookmarks", "aria-label");
  await click(path, "aria-label");
  await waitForDocument();
  await click(`Remove bookmark for ${path}`, "aria-label");
  await waitForBookmark(false);
  await checkFolder();

  await restart([]);
  await click("Bookmarks", "aria-label");
  await waitForBookmark(false);
});
