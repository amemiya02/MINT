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
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import JSZip from "jszip";

const driver = process.env.TAURI_DRIVER_URL ?? "http://127.0.0.1:4444";
const application = process.env.MINT_APP;

/** WebDriver's key codes (https://w3c.github.io/webdriver/#keyboard-actions). */
const keys = {
  control: "\uE009",
  f2: "\uE032",
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
  // A previous session can still own a GTK window while an unsaved draft closes.
  const { stdout } = await exec("pgrep", ["-n", "-x", "mint"]);
  await exec(
    "xdotool",
    [
      "search",
      "--all",
      "--onlyvisible",
      "--pid",
      stdout.trim(),
      "--name",
      "MINT$",
      "windowfocus",
      "--sync",
    ],
    { timeout: 5000 },
  );
  await exec("xdotool", ["key", chord], { timeout: 5000 });
}

async function openSettings() {
  // The webview can display the document before GTK has installed its native menu.
  await until("the native Settings menu command to open Settings", async () => {
    const open = await command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: "return document.querySelector('dialog[open] h2')?.textContent === 'Settings'",
      args: [],
    });
    if (open) return true;
    await nativeShortcut("ctrl+comma");
    return null;
  }).catch(explain);
}

/** WebDriver selects a real disk file directly on the WebView's upload control. */
async function choosePackage(button: string, path: string) {
  await command("POST", `/session/${session}/execute/sync`, {
    script: `document.addEventListener('click', function intercept(event) {
      if (!event.target.matches?.('input[type=file]')) return;
      event.preventDefault();
      document.removeEventListener('click', intercept, true);
    }, true);`,
    args: [],
  });
  await click(button);
  const input = await command<Record<string, string>>("POST", `/session/${session}/element`, {
    using: "css selector",
    value: "dialog[open] input[type=file]",
  });
  await command("POST", `/session/${session}/element/${input[elementKey]}/value`, { text: path });
}

/** GTK file pickers are native windows outside the WebDriver DOM. */
async function chooseNativePath(button: string, titlePattern: string, path: string) {
  const choose = async () => {
    const id = await until(`native chooser ${titlePattern}`, async () => {
      const { stdout } = await exec("xdotool", ["search", "--onlyvisible", "--name", titlePattern]);
      return stdout.trim().split(/\s+/).at(-1) || null;
    });
    await exec("xdotool", ["windowfocus", "--sync", id], { timeout: 5000 });
    await exec("xdotool", ["key", "--clearmodifiers", "ctrl+l", "ctrl+a"]);
    await exec("xdotool", ["type", "--clearmodifiers", "--", path]);
    await exec("xdotool", ["key", "Return"]);
  };
  await Promise.all([
    clickPath(`//button[not(@disabled) and normalize-space(.)='${button}']`),
    choose(),
  ]);
}

async function invokeNative<T>(name: string, args: object): Promise<T> {
  const result = await command<{ value: T } | { error: string }>(
    "POST",
    `/session/${session}/execute/async`,
    {
      script: `const [name, params, done] = arguments;
      window.__TAURI_INTERNALS__.invoke(name, params).then(value => done({value}), error => done({error: String(error)}));`,
      args: [name, args],
    },
  );
  if ("error" in result) throw new Error(result.error);
  return result.value;
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
  await until("the Kanban fixture folder to open", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `return !!document.querySelector('[role=treeitem][aria-label="card.md"]')`,
      args: [],
    }).then((ready) => ready || null),
  ).catch(explain);
  await openSettings();
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
  await openSettings();
  await clickPath(grant("Change the status"));
  await click("Close");
  await until("the granted Kanban status control to receive focus", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `const select = document.querySelector('aside select[aria-label="Move card.md"]:enabled');
        if (!select) return false;
        select.scrollIntoView({block: 'nearest', inline: 'center'});
        select.focus();
        return document.activeElement === select;`,
      args: [],
    }).then((ready) => ready || null),
  ).catch(explain);
  // From Draft the next matching option wraps to Done.
  await keyActions(typing("d"));
  await until(
    "the status update to reach disk",
    async () => (await readFile(path, "utf8")) === draft.replace("'Draft'", "'Done'") || null,
  ).catch(explain);
  await restart([folder]);
  await click("Kanban board", "aria-label");
  await clickPath("//aside//section[@aria-label='Done']//button[normalize-space(.)='card.md']");
  assert.deepEqual(await readdir(folder), ["card.md"]);
  await openSettings();
  await clickPath("//fieldset[@aria-label='Kanban board']//button[normalize-space(.)='Uninstall']");
  await click("Close");
});

async function clickPath(xpath: string) {
  const element = await until(xpath, async () => {
    const result = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "xpath",
      value: xpath,
    });
    return result[elementKey] ?? null;
  }).catch(explain);
  await command("POST", `/session/${session}/element/${element}/click`, {});
}

const click = (label: string, by: "text" | "aria-label" = "text") =>
  clickPath(`//button[${by === "text" ? "normalize-space(.)" : "@aria-label"}='${label}']`);
const shows = (text: string) =>
  until(text, () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script:
        "return document.querySelector('dialog[open]')?.innerText.includes(arguments[0]) === true",
      args: [text],
    }).then((found) => (found ? true : null)),
  ).catch(explain);

test("preview, disambiguate, move and undo wikilinks in a native folder", async () => {
  assert.ok(application);
  const folder = await mkdtemp(join(dir, "wikilinks-"));
  const source = join(folder, "draft.md");
  const target = join(folder, "Report.md");
  const archive = join(folder, "archive");
  const other = join(archive, "Report.md");
  const moved = join(archive, "Renamed.md");
  const otherBytes = Buffer.from("# Archived report\n");
  const draft = Buffer.from(
    "\uFEFF# Draft\r\n\r\nSee [[/Report.md#Results|evidence]].  \r\n[[Report#Results|notes]] and [data](Report.md#Results)\n",
  );
  await mkdir(archive);
  await writeFile(other, otherBytes);
  const report = Buffer.from("# Report\n\n## Results\n\nA flock of herons.\n");
  await writeFile(source, draft);
  await writeFile(target, report);
  await restart([folder, source]);
  await until("the folder and draft to open", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `return document.querySelector('[role=tab][aria-selected=true]')?.title === arguments[0] &&
        !!document.querySelector('[role=treeitem][aria-label="Report.md"]');`,
      args: [source],
    }).then((ready) => ready || null),
  ).catch(explain);
  const toggleSetting = async (enabled: boolean) => {
    await openSettings();
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
  await invokeNative("record_version", { path: target, text: "Earlier native report" });
  const [version] = await invokeNative<number[]>("list_versions", { path: target });
  assert.ok(version);
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
  assert.deepEqual(await readFile(source), draft);
  assert.deepEqual(await readFile(target), report);

  const treeItem = await command<Record<string, string>>("POST", `/session/${session}/element`, {
    using: "css selector",
    value: '[role=treeitem][aria-label="Report.md"]',
  });
  // F2 opens the tree's rename field. Replace the selected stem and extension.
  await command("POST", `/session/${session}/element/${treeItem[elementKey]}/value`, {
    text: keys.f2,
  });
  await until(
    "the rename field to receive focus",
    async () =>
      (await command<boolean>("POST", `/session/${session}/execute/sync`, {
        script: "return document.activeElement?.getAttribute('aria-label') === 'Name'",
        args: [],
      })) || null,
  ).catch(explain);
  await keyActions([...chord(keys.control, "a"), ...typing(`archive/Renamed.md${keys.enter}`)]);
  await shows("[[Report#Results|notes]]");
  const choice = await command<Record<string, string>>("POST", `/session/${session}/element`, {
    using: "xpath",
    value: "//dialog//select/option[normalize-space(.)='Report.md']",
  });
  await command("POST", `/session/${session}/element/${choice[elementKey]}/click`, {});
  await shows("→ [[archive/Renamed.md#Results|notes]]");
  await click("Move and update links");
  const updated = Buffer.from(
    "\uFEFF# Draft\r\n\r\nSee [[archive/Renamed.md#Results|evidence]].  \r\n[[archive/Renamed.md#Results|notes]] and [data](archive/Renamed.md#Results)\n",
  );
  await until(
    "the selected references to reach disk",
    async () => (await readFile(source)).equals(updated) || null,
  ).catch(explain);
  assert.deepEqual(await readFile(moved), report);
  assert.deepEqual(await readFile(other), otherBytes);
  await assert.rejects(readFile(target), { code: "ENOENT" });
  assert.equal(
    await invokeNative("read_version", { path: moved, id: version }),
    "Earlier native report",
  );
  assert.deepEqual(await invokeNative("list_versions", { path: target }), []);
  await click("Undo move");
  await until(
    "undo to restore the native file path",
    async () => (await readFile(target)).equals(report) || null,
  ).catch(explain);
  await assert.rejects(readFile(moved), { code: "ENOENT" });
  assert.deepEqual(await readFile(other), otherBytes);
  assert.equal(
    await invokeNative("read_version", { path: target, id: version }),
    "Earlier native report",
  );
  assert.deepEqual(await invokeNative("list_versions", { path: moved }), []);
  await toggleSetting(false);
  assert.deepEqual(await readFile(source), draft);
  assert.deepEqual(await readFile(target), report);
  assert.deepEqual((await readdir(folder)).sort(), ["Report.md", "archive", "draft.md"]);
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

  await restart([folder, path]);
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

test("the native statistics view refuses a denied read and allows an explicit grant", async () => {
  const path = join(dir, "statistics.md");
  await writeFile(path, "a native draft");
  await restart([path]);
  await waitForView(
    "the statistics draft to open",
    "return document.activeElement?.matches('.cm-content') && document.activeElement.textContent === 'a native draft';",
  );
  await openSettings();
  await clickPath(
    "//fieldset[@aria-label='Writing statistics']//button[normalize-space(.)='Install']",
  );
  await shows("Read the current document");
  await click("Deny access");
  await click("Close");
  await click("Writing statistics");
  await shows("Permission to read the current document was denied.");
  await click("Close");
  await openSettings();
  await clickPath(
    "//fieldset[@aria-label='Writing statistics']//button[normalize-space(.)='Allow access']",
  );
  await click("Close");
  await click("Writing statistics");
  await shows("Words: 3");
  await click("Close");
  await openSettings();
  await clickPath(
    "//fieldset[@aria-label='Writing statistics']//button[normalize-space(.)='Uninstall']",
  );
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
    const path = join(dir, "smoke.mint.json");
    await writeFile(path, JSON.stringify(manifest));
    await choosePackage("Install a MINT plugin file", path);
  };
  const path = join(dir, "update.md");
  await writeFile(path, "plugin update draft");
  await restart([path]);
  await waitForView(
    "the plugin update draft to open",
    "return document.activeElement?.matches('.cm-content') && document.activeElement.textContent === 'plugin update draft';",
  );
  await keyActions(chord(keys.control, keys.end));
  await openSettings();
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
  await openSettings();
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
  await nativeShortcut("ctrl+s");
  await until("the authorized template edit to be saved", async () =>
    (await readFile(path, "utf8")) === "plugin update draftSMOKE WRITE" ? true : null,
  ).catch(explain);
  await openSettings();
  await clickPath(
    "//fieldset[@aria-label='Smoke toolkit']//button[normalize-space(.)='Uninstall']",
  );
  await click("Close");
});

const waitForView = (message: string, script: string) =>
  until(
    message,
    async () =>
      (await command<boolean>("POST", `/session/${session}/execute/sync`, {
        script,
        args: [],
      })) || null,
  ).catch(explain);

test("the task summary reads only granted folder documents and preserves their bytes", async () => {
  const folder = await mkdtemp(join(dir, "tasks-"));
  const draft = join(folder, "draft.md");
  const other = join(folder, "finished.markdown");
  const outside = join(dir, "outside-tasks.md");
  const source = Buffer.from("\uFEFF# Draft\r\n\r\n- [ ] Review evidence  \r\n");
  const finished = Buffer.from("- [x] Finish notes\n");
  const privateTask = Buffer.from("- [ ] Outside this folder\n");
  await writeFile(draft, source);
  await writeFile(other, finished);
  await writeFile(outside, privateTask);
  await symlink(outside, join(folder, "outside-link.md"));
  await restart([folder]);
  await waitForView(
    "the task folder",
    `return !!document.querySelector('[role=treeitem][aria-label="draft.md"]')`,
  );
  const plugin = "//fieldset[@aria-label='Task summary']";
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Install']`);
  await shows("Read Markdown documents in the current folder");
  await click("Deny access");
  await click("Close");
  await click("Task summary", "aria-label");
  const view = `document.querySelector('aside[aria-label="Task summary"]')`;
  await waitForView(
    "the denied task view",
    `return ${view}?.querySelector('[role=alert]')?.textContent.includes('denied') && !${view}.querySelector('button')`,
  );
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Allow access']`);
  await click("Close");
  await waitForView(
    "only the two in-folder Markdown tasks",
    `const tasks = ${view}; return tasks?.querySelectorAll('button').length === 2 &&
      tasks.textContent.includes('Review evidence') && tasks.textContent.includes('Finish notes')`,
  );
  assert.deepEqual(await readFile(other), finished);
  await clickPath("//aside[@aria-label='Task summary']//button[contains(.,'Review evidence')]");
  await waitForView(
    "the selected task",
    "return document.getSelection()?.toString() === 'Review evidence'",
  );
  const updated = Buffer.from("- [ ] Recheck notes\n");
  await writeFile(other, updated);
  await waitForView(
    "an external edit in the task view",
    `return ${view}?.textContent.includes('Recheck notes')`,
  );
  assert.deepEqual(await readFile(draft), source);
  assert.deepEqual(await readFile(other), updated);
  assert.deepEqual(await readFile(outside), privateTask);
  assert.deepEqual((await readdir(folder)).sort(), [
    "draft.md",
    "finished.markdown",
    "outside-link.md",
  ]);
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Uninstall']`);
  await click("Close");
});

test("the installed relationship graph respects folder access and preserves the linked files", async () => {
  const folder = await mkdtemp(join(dir, "graph-"));
  const source = join(folder, "source.md");
  const target = join(folder, "target.md");
  const citation = "[proof](target.md#Findings)";
  const sourceBytes = Buffer.from(
    `\uFEFF# Draft\r\n\r\nSee ${citation} and [outside](../smoke.md).  \r\n`,
  );
  const targetBytes = Buffer.from("# Report\r\n\r\n## Findings\r\n");
  await writeFile(source, sourceBytes);
  await writeFile(target, targetBytes);
  await restart([folder, source]);
  await waitForView(
    "the graph fixture to open",
    `return !!document.querySelector('[role=treeitem][aria-label="target.md"]')`,
  );
  const plugin = "//fieldset[@aria-label='Relationship graph']";
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Install']`);
  await shows("Read Markdown documents in the current folder");
  await click("Deny access");
  await click("Close");
  await click("Relationship graph", "aria-label");
  await waitForView(
    "the denied graph to hide its files",
    `const graph = document.querySelector('aside[aria-label="Relationship graph"]');
    return graph?.querySelector('[role=alert]')?.textContent.includes('denied') && !graph.querySelector('button');`,
  );
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Allow access']`);
  await click("Close");
  const edges = "//aside[@aria-label='Relationship graph']//ul[@aria-label='References']";
  await waitForView(
    "only the in-folder reference",
    `return document.querySelectorAll('aside[aria-label="Relationship graph"] li').length === 1`,
  );
  await clickPath(`${edges}//button[contains(.,'target.md')]`);
  await waitForView(
    "the referenced heading",
    `return document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent.includes('Findings')`,
  );
  await clickPath(`${edges}//button[contains(.,'source.md')]`);
  await waitForView(
    "the original citation",
    `return document.getSelection()?.toString() === '${citation}'`,
  );
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Disable']`);
  await click("Close");
  await waitForView(
    "the disabled graph to close",
    `return !document.querySelector('aside[aria-label="Relationship graph"], nav button[aria-label="Relationship graph"]')`,
  );
  assert.deepEqual(await readFile(source), sourceBytes);
  assert.deepEqual(await readFile(target), targetBytes);
  assert.deepEqual((await readdir(folder)).sort(), ["source.md", "target.md"]);
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Uninstall']`);
  await click("Close");
});

test("the native slide presentation returns to the draft and preserves its bytes", async () => {
  const path = join(dir, "slides.md");
  const source = Buffer.from(
    "\uFEFF# Opening\r\n\r\nFirst slide.  \r\n\r\n---\r\n\r\n# Closing\r\n",
  );
  await writeFile(path, source);
  await restart([path]);
  await until("the presentation manuscript to open", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script:
        "return document.querySelector('.cm-content')?.textContent.includes('Closing') === true",
      args: [],
    }).then((ready) => ready || null),
  ).catch(explain);
  await openSettings();
  const plugin = "//fieldset[@aria-label='Slide presentation']";
  await clickPath(`${plugin}//button[normalize-space(.)='Install']`);
  await click("Allow access");
  await click("Close");
  await click("Present slides");
  await shows("First slide.");
  await click("Next slide");
  await shows("Closing");
  await click("Previous slide");
  await shows("First slide.");
  await click("Exit presentation");
  await until("the manuscript to receive focus again", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: "return document.activeElement?.matches('.cm-content') === true",
      args: [],
    }).then((ready) => ready || null),
  ).catch(explain);
  assert.deepEqual(await readFile(path), source);
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Uninstall']`);
  await click("Close");
});

test("only granted Zotero reads reach the local service and the chosen item is saved", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || !req.url?.startsWith("/api/users/0/items/top?")) {
      res.writeHead(404).end();
      return;
    }
    requests++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify([{ key: "TEST1234", data: { itemType: "book", title: "Fixture reference" } }]),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(23119, "127.0.0.1", resolve);
  });
  try {
    const path = join(dir, "zotero.md");
    await writeFile(path, "Field notes.  ");
    await restart([path]);
    await until("the citation draft", () =>
      command<boolean>("POST", `/session/${session}/execute/sync`, {
        script:
          "return document.activeElement?.matches('.cm-content') && document.activeElement.textContent.includes('Field notes.')",
        args: [],
      }).then((ok) => ok || null),
    ).catch(explain);
    await keyActions(chord(keys.control, keys.end));
    const settingsButton = async (label: string) => {
      const el = await until(label, () =>
        command<Record<string, string>>("POST", `/session/${session}/element`, {
          using: "xpath",
          value: `//fieldset[@aria-label='Zotero']//button[normalize-space(.)='${label}']`,
        }).then((el) => el[elementKey] ?? null),
      ).catch(explain);
      await command("POST", `/session/${session}/element/${el}/click`, {});
    };
    await openSettings();
    await settingsButton("Install");
    await shows("Connect to the local Zotero library");
    await click("Deny access");
    await click("Close");
    await click("Insert Zotero citation");
    await shows("Zotero access was denied");
    assert.equal(requests, 0);
    await click("Close");
    await openSettings();
    await settingsButton("Allow access");
    await settingsButton("Allow access");
    await click("Close");
    await click("Insert Zotero citation");
    await click("Fixture reference");
    await nativeShortcut("ctrl+s");
    await until("the citation on disk", async () =>
      (await readFile(path, "utf8")) ===
      "Field notes.  [Fixture reference](zotero://select/library/items/TEST1234)"
        ? true
        : null,
    ).catch(explain);
    assert.ok(requests > 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the daily journal creates one ordinary Markdown file only after permission is granted", async () => {
  const folder = await mkdtemp(join(dir, "journal-"));
  const draft = join(folder, "draft.md");
  await writeFile(draft, "Another manuscript.  \r\n");
  await restart([folder, draft]);
  const plugin = "//fieldset[@aria-label='Daily journal']";
  const chooseJournal = async () => {
    await nativeShortcut("ctrl+shift+p");
    await keyActions(typing("journal"));
    await shows("Open today’s journal");
    await keyActions(typing(keys.enter));
  };
  await clickPath("//*[@role='treeitem' and @aria-label='draft.md']");
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Install']`);
  await shows("Create today’s Markdown journal in the current folder and open it");
  await click("Deny access");
  await click("Close");
  await chooseJournal();
  await until("the journal permission denial", () =>
    command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "xpath",
      value: "//*[@role='alert' and contains(., 'Journal access was denied')]",
    }).then((el) => el[elementKey] ?? null),
  ).catch(explain);
  assert.deepEqual(await readdir(folder), ["draft.md"]);
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Allow access']`);
  await click("Close");
  await chooseJournal();
  const filename = await until(
    "today’s Markdown file on disk",
    async () =>
      (await readdir(folder)).find((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)) ?? null,
  ).catch(explain);
  const path = join(folder, filename);
  assert.equal(await readFile(path, "utf8"), `# ${filename.slice(0, -3)}\n\n`);
  await click(`Close ${filename}`, "aria-label");
  const external = Buffer.from("\uFEFF# Field notes\r\n\r\nFrom another editor.  \r\n");
  await writeFile(path, external);
  await chooseJournal();
  await until("the externally edited journal to open", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script:
        "return document.activeElement?.matches('.cm-content') && document.activeElement.innerText.includes('From another editor.')",
      args: [],
    }).then((opened) => opened || null),
  ).catch(explain);
  assert.deepEqual(await readFile(path), external);
  assert.equal(await readFile(draft, "utf8"), "Another manuscript.  \r\n");
  assert.deepEqual((await readdir(folder)).sort(), [filename, "draft.md"]);
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Uninstall']`);
  await click("Close");
});

test("import a hidden Notion attachment and embed its granted bytes in a native DOCX", async () => {
  const folder = await mkdtemp(join(dir, "publication-"));
  const archive = join(folder, "Notebook.zip");
  const doc = "# Map\n\n![Field map](.attachments/map.png)\n";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
  const input = await new JSZip()
    .file("Map.md", doc)
    .file(".attachments/map.png", png)
    .generateAsync({ type: "nodebuffer" });
  await writeFile(archive, input);
  await restart([folder]);
  await waitForView(
    "the archive to appear in the folder tree",
    `return !!document.querySelector('[role=treeitem][aria-label="Notebook.zip"]');`,
  );
  await openSettings();
  await clickPath("//fieldset[@aria-label='Notion import']//button[normalize-space(.)='Install']");
  await click("Allow access");
  await click("Close");
  const chooseFormat = async (label: string) => {
    await nativeShortcut("ctrl+shift+p");
    await keyActions(typing("Import / Export"));
    await shows("Import / Export…");
    await keyActions(typing(keys.enter));
    await waitForView(
      "the format chooser to receive focus",
      `const select = document.querySelector('dialog[open] select:has(option[value="docx"])');
       if (!select) return false;
       select.focus();
       return document.activeElement === select;`,
    );
    await keyActions(typing(label.charAt(0).toLowerCase()));
    await waitForView(
      `the ${label} format to be selected`,
      `return document.querySelector('dialog[open] select:has(option[value="docx"]) option:checked')?.label === ${JSON.stringify(label)};`,
    );
  };
  await chooseFormat("Notion import");
  await choosePackage("Notion export (.zip)", archive);
  await chooseNativePath("Import", "^Choose the parent folder for the import$", folder);
  await click("Open imported folder");
  await clickPath("//*[@role='treeitem' and @aria-label='Map.md']");
  const imported = join(folder, "Notebook");
  assert.equal(await readFile(join(imported, "Map.md"), "utf8"), doc);
  assert.deepEqual(await readFile(join(imported, ".attachments", "map.png")), png);
  assert.deepEqual(await readFile(archive), input);
  const denied = join(imported, "ungranted.png");
  await symlink("/etc/hosts", denied);
  await assert.rejects(
    invokeNative("read_binary_file", { path: denied }),
    /outside the documents and folders/,
  );
  await chooseFormat("DOCX");
  const out = join(imported, "share.docx");
  await chooseNativePath("Export", "^Export as DOCX$", out);
  const bytes = await until("the DOCX on disk", () => readFile(out));
  const word = await JSZip.loadAsync(bytes);
  assert.match((await word.file("word/document.xml")?.async("string")) ?? "", /<w:drawing>/);
  assert.deepEqual(await word.file(/^word\/media\/.+\.png$/i)[0]?.async("nodebuffer"), png);
});
