// Smoke tests of the desktop app driven through tauri-driver and WebKitWebDriver.
// See the Linux smoke job in .github/workflows/ci.yml for the private D-Bus
// session, Secret Service and X display used by the suite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import JSZip from "jszip";
import type { SavedWritingTask } from "../src/ai/writing-tasks.ts";
import {
  selectedPageText,
  writingMaterialChart,
  writingMaterialPdf,
} from "../test-fixtures/writing-materials.ts";

const driver = process.env.TAURI_DRIVER_URL ?? "http://127.0.0.1:4444";
const application = process.env.MINT_APP;
const instanceName = "io.github.amemiya02.mint.SingleInstance";

/** WebDriver's key codes (https://w3c.github.io/webdriver/#keyboard-actions). */
const keys = {
  control: "\uE009",
  f2: "\uE032",
  end: "\uE010",
  home: "\uE011",
  shift: "\uE008",
  enter: "\uE007",
  escape: "\uE00C",
  tab: "\uE004",
} as const;
/** The element reference key of the WebDriver protocol. */
const elementKey = "element-6066-11e4-a52e-4f735466cecf";

async function command<T>(method: string, path: string, body?: unknown): Promise<T> {
  assert.ok(!path.startsWith("/session//") && path !== "/session/", "no active WebDriver session");
  const response = await fetch(`${driver}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(45_000),
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

async function busCall(method: string, ...args: string[]) {
  const { stdout } = await exec(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      `org.freedesktop.DBus.${method}`,
      ...args,
    ],
    { timeout: 5000 },
  );
  return stdout.trim();
}

async function waitForInstanceExit() {
  // WebKitWebDriver can acknowledge DELETE before MINT drops its single-instance name.
  await until(
    `D-Bus name ${instanceName} to be released`,
    async () => (await busCall("NameHasOwner", instanceName)) === "(false,)" || null,
  );
}

async function instancePid() {
  const reply = await busCall("GetConnectionUnixProcessID", instanceName);
  const pid = /^\(uint32 (\d+),\)$/.exec(reply)?.[1];
  assert.ok(pid, `expected a process ID for ${instanceName}, got ${reply}`);
  return pid;
}

/** WebDriver's keyboard targets the webview. Native menu accelerators belong to its GTK window. */
async function nativeShortcut(chord: string) {
  const pid = await instancePid();
  await exec(
    "xdotool",
    ["search", "--all", "--onlyvisible", "--pid", pid, "--name", "MINT$", "windowfocus", "--sync"],
    { timeout: 5000 },
  );
  await exec("xdotool", ["key", "--clearmodifiers", chord], { timeout: 5000 });
}

async function nativeMenuItem(menu: string, item: string, mode: "wait" | "activate" = "activate") {
  await exec(
    "/usr/bin/python3",
    ["smoke/activate-gtk-menu.py", mode, await instancePid(), menu, item],
    { timeout: 20_000 },
  ).catch(explain);
}

async function openSettings() {
  await nativeMenuItem("MINT", "Settings…");
  await waitForView(
    "the native Settings menu command to open Settings",
    "return document.querySelector('dialog[open] h2')?.textContent === 'Settings'",
  );
}

/** WebDriver selects a real disk file directly on the WebView's upload control. */
async function chooseWebViewFile(button: string, path: string, owner = "dialog[open]") {
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
    value: `${owner} input[type=file]`,
  });
  await command("POST", `/session/${session}/element/${input[elementKey]}/value`, { text: path });
}

/** GTK file pickers are native windows outside the WebDriver DOM. */
async function chooseNativePath(button: string, title: string, path: string, accept: string) {
  await Promise.all([
    clickPath(`//button[not(@disabled) and normalize-space(.)='${button}']`),
    exec("/usr/bin/python3", ["smoke/choose-gtk-path.py", title, path, accept], {
      timeout: 60_000,
    }),
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
      'return document.body.innerText + "\\n(document focused: " + document.hasFocus() + ", active element: " + document.activeElement?.className + ")"',
    args: [],
  }).catch((err: unknown) => `(cannot read the page: ${String(err)})`);
  throw new Error(`${String(e)}\n--- the window shows ---\n${page}`);
}

let dir = "";
let document = "";
let session = "";

before(async () => {
  assert.ok(application, "set MINT_APP to the built MINT binary");
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, "run native smoke in a private D-Bus session");
  await until(
    "WebDriver to accept a session",
    async () => (await command<{ ready: boolean }>("GET", "/status")).ready || null,
  );
  dir = await mkdtemp(join(tmpdir(), "mint-smoke-"));
  document = join(dir, "smoke.md");
  await writeFile(document, "\uFEFF# Smoke\r\n\r\nfirst line  ");
  await restart([document]);
});

after(async () => {
  try {
    if (session) await stopSession();
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
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

async function stopSession() {
  await command("DELETE", `/session/${session}`);
  session = "";
  await waitForInstanceExit();
}

async function restart(args: string[]) {
  if (session) await stopSession();
  else await waitForInstanceExit();
  const created = await command<{ sessionId: string }>("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application, args } } },
  });
  assert.ok(created.sessionId, "WebDriver did not create a native session");
  session = created.sessionId;
  await busCall("GetNameOwner", instanceName);
  // A live window and D-Bus owner can precede registration of GTK accelerators.
  await nativeMenuItem("MINT", "Settings…", "wait");
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

test("a second native launch opens its document in the running instance", async (t) => {
  assert.ok(application);
  const folder = await mkdtemp(join(tmpdir(), "mint-activation-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "activation.md");
  await writeFile(path, "Opened through the running instance.");
  const primary = await busCall("GetNameOwner", instanceName);
  await exec(resolve(application), [basename(path)], { cwd: folder, timeout: 10_000 });
  await waitForView(
    "the forwarded document in the original session",
    `return [...document.querySelectorAll('.cm-content')]
      .some(editor => editor.textContent === 'Opened through the running instance.');`,
  );
  assert.equal(await busCall("GetNameOwner", instanceName), primary);
});

test("import a hidden Notion attachment and embed its granted bytes in a native DOCX", async (t) => {
  const folder = await mkdtemp(join(homedir(), "mint-publication-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
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
  await clickPluginReview("Notion import", "Allow access");
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
  await chooseWebViewFile("Notion export (.zip)", archive);
  await chooseNativePath("Import", "Choose the parent folder for the import", folder, "Open");
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
  await chooseNativePath("Export", "Export as DOCX", out, "Save");
  const bytes = await until("the DOCX on disk", () => readFile(out));
  const word = await JSZip.loadAsync(bytes);
  assert.match((await word.file("word/document.xml")?.async("string")) ?? "", /<w:drawing>/);
  assert.deepEqual(await word.file(/^word\/media\/.+\.png$/i)[0]?.async("nodebuffer"), png);
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
  await clickPluginReview("Kanban board", "Deny access");
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
  const element = await until(`a clickable match for ${xpath}`, async () => {
    const matches = await command<Record<string, string>[]>(
      "POST",
      `/session/${session}/elements`,
      {
        using: "xpath",
        value: xpath,
      },
    );
    // XPath also matches hidden panes and content behind a modal. WebKitWebDriver
    // can find a control in a scroll area before its center can receive a click.
    // WebKitGTK 2.50 resolves element references only at the top level of args.
    return command<Record<string, string> | null>("POST", `/session/${session}/execute/sync`, {
      script: `const modalOpen = document.querySelector('dialog:modal') !== null;
        for (const element of arguments) {
          if ((modalOpen && !element.closest('dialog:modal')) || element.matches(':disabled') ||
              element.closest('[hidden], [inert]') || !element.getClientRects().length) continue;
          element.scrollIntoView({ block: 'center', inline: 'nearest' });
          const rect = element.getClientRects()[0];
          if (!rect) continue;
          const left = Math.max(rect.left, 0), right = Math.min(rect.right, innerWidth);
          const top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, innerHeight);
          if (left >= right || top >= bottom) continue;
          const hit = document.elementFromPoint(Math.floor((left + right) / 2), Math.floor((top + bottom) / 2));
          if (element.contains(hit)) return element;
        }
        return null;`,
      args: matches,
    });
  }).catch(explain);
  await command("POST", `/session/${session}/element/${element[elementKey]}/click`, {}).catch(
    explain,
  );
}

const click = (label: string, by: "text" | "aria-label" = "text") =>
  clickPath(`//button[${by === "text" ? "normalize-space(.)" : "@aria-label"}='${label}']`);
const clickSettingsButton = (label: string, group?: string) =>
  clickPath(
    `//dialog[@open][.//h2[normalize-space(.)='Settings']]${group ? `//fieldset[legend[normalize-space(.)='${group}']]` : ""}//button[normalize-space(.)='${label}']`,
  );
const clickPluginReview = (name: string, action: string) =>
  clickPath(
    `//dialog[@open]//fieldset[legend[normalize-space(.)='${name}']]//button[normalize-space(.)='${action}']`,
  );
const showsIn = (selector: string, text: string) =>
  until(text, () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `return [...document.querySelectorAll(arguments[0])].some(element =>
        element.getClientRects().length && element.innerText.includes(arguments[1]));`,
      args: [selector, text],
    }).then((found) => (found ? true : null)),
  ).catch(explain);
const shows = (text: string) => showsIn("dialog[open]", text);

const chooseSettingsOption = (setting: string, label: string) =>
  until(`${setting} to offer ${label}`, () =>
    command<string | null>("POST", `/session/${session}/execute/sync`, {
      script: `const select = [...document.querySelectorAll('dialog[open] label')]
        .find(label => label.textContent.trim() === arguments[0])?.control;
        const option = select && [...select.options].find(item => item.text === arguments[1]);
        if (!option || option.disabled || select.disabled) return null;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return option.value;`,
      args: [setting, label],
    }),
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
    await clickPath(
      `//input[@id=//label[normalize-space(.)='Recognize wikilinks in ${folder}']/@for]`,
    );
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

test("annotations survive a native restart outside the working folder", async () => {
  const folder = await mkdtemp(join(dir, "annotations-"));
  const path = join(folder, "annotated.md");
  const original = Buffer.from("\uFEFFField notes.  \r\n\r\nUntouched.\n");
  const note = "Check the native manuscript.";
  await writeFile(path, original);
  await restart([path]);
  await clickPath("//div[contains(@class, 'cm-content')][contains(., 'Field notes.')]");
  await keyActions([...chord(keys.control, keys.home), ...chord(keys.shift, keys.end)]);
  await click("Add annotation");
  const field = await command<Record<string, string>>("POST", `/session/${session}/element`, {
    using: "css selector",
    value: "dialog[open] textarea",
  });
  await command("POST", `/session/${session}/element/${field[elementKey]}/value`, { text: note });
  await click("Save annotation");
  await click("Mark resolved");
  await until("the annotation decision to reach native app data", async () => {
    const annotations = await invokeNative<Record<string, { note: string; resolved: boolean }>>(
      "read_annotations",
      { path },
    );
    return Object.values(annotations).some((item) => item.note === note && item.resolved) || null;
  }).catch(explain);
  await assert.rejects(
    invokeNative("read_annotations", { path: join(tmpdir(), "mint-ungranted-annotation.md") }),
    /outside the documents and folders/,
  );

  await restart([path]);
  await click("Annotations");
  await clickPath("//section[@aria-label='Resolved']//button[normalize-space(.)='Go to target']");
  const visible = await command<{ excerpt: string; selected: string }>(
    "POST",
    `/session/${session}/execute/sync`,
    {
      script: `return {
        excerpt: document.querySelector('section[aria-label="Resolved"] blockquote')?.textContent,
        selected: getSelection()?.toString()
      };`,
      args: [],
    },
  );
  assert.equal(visible.excerpt, "Field notes.  ");
  assert.equal(visible.selected, "Field notes.  ");
  assert.deepEqual(await readFile(path), original);
  assert.deepEqual(await readdir(folder), ["annotated.md"]);
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
  await clickPluginReview("Writing statistics", "Deny access");
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
    await chooseWebViewFile("Install a MINT plugin file", path);
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
  await clickPluginReview(original.name, "Allow access");
  await upload(expanded);
  await shows("Modify the current document at the selection");
  await clickPluginReview(`Update ${expanded.name}`, "Keep current version");
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
  await clickPluginReview(`Update ${expanded.name}`, "Allow and update");
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

async function runPaletteCommand(title: string, query = title) {
  await nativeMenuItem("View", "Command Palette…");
  const palette = 'dialog[open][aria-label="Command Palette"]';
  await waitForView(
    "the Command Palette to receive focus",
    `return document.activeElement?.matches(${JSON.stringify(`${palette} input`)});`,
  );
  await keyActions(typing(query));
  await waitForView(
    `${title} to be selected in the Command Palette`,
    `return document.querySelector(${JSON.stringify(`${palette} [role=option][aria-selected=true] > span`)})
      ?.textContent === ${JSON.stringify(title)};`,
  );
  await keyActions(typing(keys.enter));
}

async function tabToView(what: string, script: string) {
  for (let step = 0; step < 24; step++) {
    const focused = await command<boolean>("POST", `/session/${session}/execute/sync`, {
      script,
      args: [],
    });
    if (focused) return;
    await keyActions(typing(keys.tab));
  }
  assert.fail(`could not reach ${what} by keyboard`);
}

const waitForActiveDocument = (path: string) =>
  waitForView(
    `${basename(path)} to open and receive focus`,
    `const tab = document.querySelector('[role=tab][aria-selected=true]');
     return tab?.textContent === ${JSON.stringify(basename(path))} &&
       document.activeElement?.matches('.cm-content') &&
       document.activeElement.closest('[role=tabpanel]')?.id === tab.getAttribute('aria-controls');`,
  );

const chooseCustomDraftConnection = () =>
  waitForView(
    "the custom compatible service in Draft with AI",
    `const form = document.querySelector('[role="tabpanel"]:not([hidden]) form[aria-labelledby]');
     if (!form) return false;
     const control = name => [...form.querySelectorAll('label')]
       .find(label => label.firstChild?.textContent.trim() === name)?.control;
     const select = control('Writing connection');
     if (!select) return !!control('API address');
     const option = [...select.options].find(option => option.label === 'Custom compatible service');
     if (!option) return false;
     select.value = option.value;
     select.dispatchEvent(new Event('change', { bubbles: true }));
     return true;`,
  );

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
  await clickPluginReview("Task summary", "Deny access");
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
  await clickPluginReview("Relationship graph", "Deny access");
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
  await clickPluginReview("Slide presentation", "Allow access");
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
    const settingsButton = (label: string) =>
      clickPath(`//fieldset[@aria-label='Zotero']//button[normalize-space(.)='${label}']`);
    await openSettings();
    await settingsButton("Install");
    await shows("Connect to the local Zotero library");
    await clickPluginReview("Zotero", "Deny access");
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

test("native citation verification reads Zotero only after approval and edits only the manuscript", async () => {
  const draft = join(dir, "verify-zotero-citation.md");
  const original = "The ridge study (Rivera, 2019) covered the northern trail.";
  const corrected =
    "The ridge study ([Rivera, 2024](zotero://select/library/items/RIDGE123)) covered the northern trail.";
  const instruction = "Verify and correct this citation, apply directly";
  const material = [
    "Title: Ridge study",
    "Creators: Ana Rivera, Ridge Field Station",
    "Date: 2024",
    "Publication: Field Reports",
    "DOI: 10.5555/ridge.2024",
    "Zotero link: zotero://select/library/items/RIDGE123",
  ].join("\n");
  const libraryRequests: {
    method?: string;
    path: string;
    query: Record<string, string>;
    body: string;
  }[] = [];
  const modelRequests: { method?: string; url?: string; task: unknown }[] = [];
  const library = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url ?? "/", "http://127.0.0.1:23119");
    libraryRequests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    });
    if (request.method !== "GET" || url.pathname !== "/api/users/0/items/top") {
      response.writeHead(405).end();
      return;
    }
    const ridge = {
      key: "RIDGE123",
      data: {
        itemType: "journalArticle",
        title: "Ridge study",
        creators: [
          { firstName: "Ana", lastName: "Rivera", creatorType: "author" },
          { name: "Ridge Field Station", creatorType: "author" },
        ],
        date: "2024",
        publicationTitle: "Field Reports",
        DOI: "10.5555/ridge.2024",
        abstractNote: "Private abstract",
        tags: [{ tag: "Private tag" }],
      },
    };
    const other = { key: "OTHER123", data: { itemType: "book", title: "Unrelated notes" } };
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(
        JSON.stringify(url.searchParams.get("q") === "Rivera & Ridge" ? [ridge] : [ridge, other]),
      );
  });
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    modelRequests.push({
      method: request.method,
      url: request.url,
      task: JSON.parse(JSON.parse(body).messages.at(-1).content),
    });
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [{ message: { content: `<replacement>${corrected}</replacement>` } }],
      }),
    );
  });
  try {
    for (const [server, port] of [
      [library, 23119],
      [model, 0],
    ] as const) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    }
    const address = model.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    await writeFile(draft, `Field notes.\n\n${original}`);
    await restart([draft]);
    await openSettings();
    await clickSettingsButton("Model connections");
    for (const [label, value] of [
      ["Connection name", "Zotero review fixture"],
      ["API address", endpoint],
      ["Model name", "zotero-review"],
    ] as const) {
      await clickPath(`//dialog[@open]//label[normalize-space(.)='${label}']/input`);
      await keyActions(typing(value));
    }
    await clickSettingsButton("Use for this launch");
    await shows("Zotero review fixture");
    await clickSettingsButton("Close");
    await waitForView(
      "the citation manuscript to receive focus",
      `return document.activeElement?.matches('.cm-content') &&
        document.activeElement.textContent.includes(${JSON.stringify(original)});`,
    );
    await keyActions([...chord(keys.control, keys.end), ...chord(keys.shift, keys.home)]);
    await click("Ask AI");
    const assistant = "//section[@aria-label='Ask AI']";
    const picker = `${assistant}//fieldset[@aria-label='Zotero (read only)']`;
    const chooseZotero = async () => {
      // The trigger sits inside the scrolling inline composer. Reach it by keyboard.
      await tabToView(
        "Add from Zotero",
        `const button = document.activeElement;
         return button?.matches('section[aria-label="Ask AI"] button[aria-expanded=false]') &&
           button.textContent.trim() === 'Add from Zotero';`,
      ).catch(explain);
      await keyActions(typing(keys.enter));
      await showsIn('section[aria-label="Ask AI"]', "Read the local Zotero library for this task?");
    };
    await chooseZotero();
    assert.deepEqual(libraryRequests, []);
    await clickPath(`${picker}//button[normalize-space(.)='Deny access']`);
    await waitForView(
      "the Zotero picker to close on denial",
      `return !document.querySelector('section[aria-label="Ask AI"] fieldset[aria-label="Zotero (read only)"]');`,
    );
    assert.deepEqual(libraryRequests, []);
    assert.deepEqual(modelRequests, []);

    await chooseZotero();
    await clickPath(`${picker}//button[normalize-space(.)='Allow once']`);
    await clickPath(`${picker}//input[@type='search']`);
    await keyActions(typing("Rivera & Ridge"));
    await clickPath(`${picker}//button[not(@disabled) and normalize-space(.)='Search']`);
    await clickPath(`${picker}//button[normalize-space(.)='Ridge study']`);
    const recipient = `Zotero review fixture · ${endpoint}`;
    await waitForView(
      "the selected Zotero fields, tool and writing recipient before sending",
      `const context = document.querySelector('section[aria-label="Ask AI"] form fieldset fieldset');
        return context?.innerText.includes(${JSON.stringify(recipient)}) &&
          context.innerText.includes('Zotero (read only)') &&
          [...context.querySelectorAll('pre')].some((card) => card.textContent === ${JSON.stringify(material)});`,
    );
    assert.deepEqual(modelRequests, []);
    await clickPath(`${assistant}//form//input`);
    await keyActions(typing(instruction));
    const send = `Apply directly · Current selection · ${recipient}`;
    await clickPath(
      `${assistant}//button[@type='submit' and not(@disabled) and normalize-space(.)='${send}']`,
    );
    await waitForView(
      "the citation revision in the native editor",
      `return document.querySelector('.cm-content')?.textContent.includes('Rivera, 2024');`,
    );
    await nativeShortcut("ctrl+s");
    await until(
      "the corrected Markdown on disk",
      async () => (await readFile(draft, "utf8")) === `Field notes.\n\n${corrected}` || null,
    ).catch(explain);
    assert.deepEqual(modelRequests, [
      {
        method: "POST",
        url: "/v1/chat/completions",
        task: {
          instruction,
          selectedText: original,
          taskContext: { materials: [{ name: "Zotero · Ridge study", text: material }] },
        },
      },
    ]);
    const browse = {
      method: "GET",
      path: "/api/users/0/items/top",
      query: { v: "3", limit: "51", sort: "title", direction: "asc", start: "0" },
      body: "",
    };
    assert.deepEqual(libraryRequests, [
      browse,
      { ...browse, query: { ...browse.query, q: "Rivera & Ridge", qmode: "titleCreatorYear" } },
    ]);
  } finally {
    for (const server of [library, model]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("a native model receives only the sample or live selection and edits through normal save", async () => {
  const draft = join(dir, "ask-ai-model.md");
  const manuscript = "\uFEFFPrivate notes.  \r\n\r\nSelected sentence.";
  const liveSelection = "Selected sentence. Author addition.";
  const edited = manuscript.replace("Selected sentence.", "Short sentence.");
  const liveManuscript = manuscript.replace("Selected sentence.", liveSelection);
  const autosave =
    "//input[@type='checkbox' and @id=//label[normalize-space(.)='Save automatically']/@for]";
  await writeFile(draft, manuscript);
  await restart([draft]);
  const requests: { url?: string; method?: string; authorization?: string; body: unknown }[] = [];
  let pendingReply: ServerResponse | undefined;
  let pendingDirect: ServerResponse | undefined;
  let pendingPreview: ServerResponse | undefined;
  let stopped = false;
  const stopInstruction = "Start another preview for the background task.";
  const directInstruction = "Shorten these lines, apply directly";
  const previewInstruction = "Revise the opening and closing.";
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      body: body && JSON.parse(body),
    });
    if (request.method !== "POST" || request.url !== "/fixture/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const payload = JSON.parse(body);
    const instruction = payload.messages.at(-1)?.content ?? "";
    if (instruction.includes(directInstruction)) {
      pendingDirect = response;
      return;
    }
    if (instruction.includes(previewInstruction)) {
      pendingPreview = response;
      return;
    }
    if (instruction.includes(stopInstruction) && stopped) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        'data: {"choices":[{"delta":{"content":"<replacement>Ready to review.</replacement>"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    if (instruction.includes(stopInstruction)) {
      response.once("close", () => {
        stopped = !response.writableEnded;
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: "<replacement>Ready to review.</replacement> Native partial text.",
              },
            },
          ],
        })}\n\n`,
      );
      return;
    }
    if (instruction.includes("apply directly")) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          choices: [
            {
              message: { content: "<replacement>Short sentence.</replacement>" },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }
    pendingReply = response;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"<replacement>Café notes"}}]}\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.listen(0, "127.0.0.1", resolve);
  });
  const address = endpoint.address();
  const secret = "one-use-native-fixture-key";

  async function fill(label: string, text: string) {
    const found = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "xpath",
      value: `//dialog[@open]//label[normalize-space(.)='${label}']/input`,
    });
    assert.ok(found[elementKey], `input for ${label}`);
    await command("POST", `/session/${session}/element/${found[elementKey]}/value`, { text });
  }

  async function askSelection(instruction: string, authorization?: string) {
    await click("Ask AI");
    await waitForView(
      "the saved model to appear in the send row",
      `return [...document.querySelectorAll('section[aria-label="Ask AI"] select option')]
        .some((option) => option.textContent.startsWith("Selection fixture · "));`,
    );
    await command("POST", `/session/${session}/execute/sync`, {
      script: `const option = [...document.querySelectorAll('section[aria-label="Ask AI"] select option')]
        .find((item) => item.textContent.startsWith("Selection fixture · "));
        option.parentElement.value = option.value;
        option.parentElement.dispatchEvent(new Event('change', { bubbles: true }));`,
      args: [],
    });
    await clickPath("//section[@aria-label='Ask AI']//input");
    await keyActions(typing(instruction));
    if (authorization) {
      await waitForView(
        "the direct edit authorization on the send button",
        `return [...document.querySelectorAll('section[aria-label="Ask AI"] button[type=submit]')]
          .some((button) => !button.disabled && button.textContent.trim() === ${JSON.stringify(authorization)});`,
      );
    }
    await keyActions(typing(keys.enter));
  }

  async function setAutosave(enabled: boolean) {
    const checked = await command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `return [...document.querySelectorAll('dialog[open] label')]
        .find((label) => label.textContent.trim() === 'Save automatically')?.control.checked;`,
      args: [],
    });
    if (checked !== enabled) await clickPath(autosave);
  }

  try {
    assert.ok(address && typeof address !== "string");
    await openSettings();
    await click("Model connections");
    await shows("Sample prompt");
    await fill("API address", `http://127.0.0.1:${address.port}/fixture/v1/chat/completions`);
    await fill("Model name", "native-fixture");
    await fill("API key", secret);
    const form = await command<{ sample: string; settingsPath: string }>(
      "POST",
      `/session/${session}/execute/sync`,
      {
        script: `const dialog = document.querySelector('dialog[open]');
          return {
            sample: dialog.querySelector('textarea[readonly]').value,
            settingsPath: dialog.querySelector('span[title$="settings.json"]').title,
          };`,
        args: [],
      },
    );
    assert.match(form.sample, /The research team met again to discuss the results\./);
    await click("Run sample");
    await shows("Café notes");
    await shows("Conversation: Unverified");
    assert.ok(pendingReply, "the first delta reached Settings before the endpoint ended");
    pendingReply.end(
      'data: {"choices":[{"delta":{"content":" were reviewed.</replacement>"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    await shows("Café notes were reviewed.");
    await shows("Conversation: Verified");
    await shows("Streaming: Verified");
    await shows("Proposed edit: Verified");
    await shows("Multi-file editing: Unavailable");
    assert.deepEqual(requests, [
      {
        url: "/fixture/v1/chat/completions",
        method: "POST",
        authorization: `Bearer ${secret}`,
        body: {
          model: "native-fixture",
          stream: true,
          messages: [{ role: "user", content: form.sample }],
        },
      },
    ]);
    const settings = await readFile(form.settingsPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    assert.ok(!settings.includes(secret), "the trial key was never saved to settings");
    await click("Close");
    await openSettings();
    await click("Model connections");
    await shows("Sample prompt");
    assert.equal(
      await command<string>("POST", `/session/${session}/execute/sync`, {
        script: "return document.querySelector('dialog[open] input[type=password]')?.value",
        args: [],
      }),
      "",
    );
    await fill("Connection name", "Selection fixture");
    await fill("API address", `http://127.0.0.1:${address.port}/fixture/v1`);
    await fill("Model name", "native-fixture");
    await fill("API key", secret);
    await click("Use for this launch");
    await shows("Selection fixture");
    await setAutosave(false);
    await click("Close");

    await waitForView(
      "the draft to regain focus",
      "return document.activeElement?.matches('.cm-content');",
    );
    await click("Open ask-ai-model.md in other pane", "aria-label");
    await waitForView(
      "two views of the manuscript with the reference pane focused",
      "return document.querySelectorAll('.cm-content').length === 2 && document.querySelectorAll('.cm-content')[1] === document.activeElement;",
    );
    await keyActions([
      ...chord(keys.control, keys.end),
      ...typing(" Author addition."),
      ...chord(keys.shift, keys.home),
    ]);
    const instruction = "Shorten this sentence, apply directly";
    const authorization = `Apply directly · Current selection · Selection fixture · http://127.0.0.1:${address.port}/fixture/v1/chat/completions`;
    await askSelection(instruction, authorization);
    await waitForView(
      "the authorized replacement in both panes with an active writing cursor",
      `const panes = [...document.querySelectorAll('.cm-content')];
        return panes.length === 2 && panes[1] === document.activeElement &&
          window.getSelection()?.isCollapsed &&
          panes.every((pane) => pane.textContent.includes('Short sentence.'));`,
    );
    assert.deepEqual(await readFile(draft), Buffer.from(manuscript));
    await click("View changes");
    await waitForView(
      "the applied change's before and after text",
      `const review = document.querySelector('aside[aria-label="Writing Assistant"]');
        return review?.innerText.includes(${JSON.stringify(liveSelection)}) &&
          review.innerText.includes('Short sentence.');`,
    );
    await clickPath("//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Close']");
    await nativeShortcut("ctrl+s");
    await until(
      "the edited bytes to be saved manually",
      async () => (await readFile(draft)).equals(Buffer.from(edited)) || null,
    ).catch(explain);
    assert.equal(requests.length, 2);
    const sent = requests[1];
    assert.ok(sent);
    assert.equal(sent.url, "/fixture/v1/chat/completions");
    assert.equal(sent.authorization, `Bearer ${secret}`);
    const payload = sent.body as {
      model: string;
      stream: boolean;
      messages: { role: string; content: string }[];
    };
    assert.equal(payload.model, "native-fixture");
    assert.equal(payload.stream, true);
    assert.deepEqual(
      payload.messages.map(({ role }) => role),
      ["system", "user"],
    );
    const selectedMessage = payload.messages[1];
    assert.ok(selectedMessage);
    assert.deepEqual(JSON.parse(selectedMessage.content), {
      instruction,
      selectedText: liveSelection,
    });
    await keyActions(chord(keys.control, "z"));
    await nativeShortcut("ctrl+s");
    await until(
      "one undo to restore the precise unsaved baseline",
      async () => (await readFile(draft)).equals(Buffer.from(liveManuscript)) || null,
    ).catch(explain);

    await click("Close reference pane", "aria-label");
    await openSettings();
    await setAutosave(true);
    await click("Close");
    const concurrentSource =
      "\uFEFFOpening line.\r\nExtra opening detail.\r\n\r\nMiddle line.\r\n\r\nKeep café spaces.  \r\n\r\nClosing line.\r\nClosing detail.\r\n";
    const authorSource = concurrentSource.replace("Middle line.", "Author's middle line.");
    const mergedSource = authorSource
      .replace("Opening line.\r\nExtra opening detail.", "Short opening.")
      .replace("Closing line.\r\nClosing detail.", "Short close.\r\nShort detail.");
    const authorBytes = Buffer.from(authorSource);
    const mergedBytes = Buffer.from(mergedSource);
    await writeFile(draft, concurrentSource);
    await waitForView(
      "the remaining view to show the CRLF manuscript",
      `return document.querySelectorAll('.cm-content').length === 1 &&
        document.activeElement?.matches('.cm-content') &&
        document.activeElement.textContent.includes('Closing detail.');`,
    );
    await keyActions(chord(keys.control, "a"));
    await askSelection(directInstruction, authorization);
    const directReply = await until(
      "the native direct edit request",
      async () => pendingDirect ?? null,
    );
    assert.deepEqual(requests[2], {
      ...sent,
      body: {
        ...payload,
        messages: [
          payload.messages[0],
          {
            role: "user",
            content: JSON.stringify({
              instruction: directInstruction,
              selectedText: concurrentSource.slice(1),
            }),
          },
        ],
      },
    });
    await clickPath("//div[contains(@class, 'cm-line') and normalize-space(.)='Middle line.']");
    await keyActions([
      ...typing(keys.home),
      ...chord(keys.shift, keys.end),
      ...typing("Author's middle line."),
    ]);
    await until(
      "the author's concurrent edit to autosave while the model is still responding",
      async () => (await readFile(draft)).equals(authorBytes) || null,
    ).catch(explain);
    directReply.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "<replacement>Short opening.\n\nModel's middle line.\n\nKeep café spaces.  \n\nShort close.\nShort detail.\n</replacement>",
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    await until(
      "only the independent direct edits to autosave with the original BOM and CRLF",
      async () => (await readFile(draft)).equals(mergedBytes) || null,
    ).catch(explain);
    await waitForView(
      "the author to retain editor focus after the direct edits",
      "return document.activeElement?.matches('.cm-content');",
    );
    await keyActions(chord(keys.control, "z"));
    await until(
      "one undo to autosave the precise author-edited baseline",
      async () => (await readFile(draft)).equals(authorBytes) || null,
    ).catch(explain);
    await keyActions(chord(keys.control, "y"));
    await until(
      "redo to autosave the precise merged bytes",
      async () => (await readFile(draft)).equals(mergedBytes) || null,
    ).catch(explain);
    await clickPath(
      "//section[@aria-label='Ask AI']//button[normalize-space(.)='Undo direct edits']",
    );
    await until(
      "reverting from the completion notice to autosave the precise author-edited baseline",
      async () => (await readFile(draft)).equals(authorBytes) || null,
    ).catch(explain);
    await clickPath("//section[@aria-label='Ask AI']//button[normalize-space(.)='View changes']");
    await showsIn('[aria-label="Proposed edit 2 of 3"]', "Author's middle line.");
    await clickPath(
      "//fieldset[@aria-label='Proposed edit 2 of 3']//button[normalize-space(.)='Apply to compared text']",
    );
    const comparedBytes = Buffer.from(
      authorSource.replace("Author's middle line.", "Model's middle line."),
    );
    await until(
      "accepting the comparison to save the entire replacement with the original BOM and CRLF",
      async () => (await readFile(draft)).equals(comparedBytes) || null,
    ).catch(explain);
    await clickPath("//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Close']");
    await keyActions(chord(keys.control, "z"));
    await until(
      "one undo to restore the author's exact bytes after accepting the comparison",
      async () => (await readFile(draft)).equals(authorBytes) || null,
    ).catch(explain);

    const reviewSource = "**Opening line.**\r\n\r\nKeep this.  \n\nClosing line.";
    await writeFile(draft, `\uFEFF${reviewSource}`);
    await waitForView(
      "the replacement draft from disk",
      `const editor = document.activeElement;
       return editor?.matches('.cm-content') && editor.textContent.includes('Keep this.') &&
         editor.textContent.includes('Closing line.');`,
    );
    await keyActions(chord(keys.control, "a"));
    await askSelection(previewInstruction);
    const previewReply = await until(
      "the native preview request",
      async () => pendingPreview ?? null,
    );
    assert.equal(requests.length, 4);
    assert.equal(requests[3]?.authorization, `Bearer ${secret}`);
    assert.deepEqual(requests[3]?.body, {
      model: "native-fixture",
      stream: true,
      messages: [
        { role: "system", content: payload.messages[0]?.content },
        {
          role: "user",
          content: JSON.stringify({ instruction: previewInstruction, selectedText: reviewSource }),
        },
      ],
    });

    const externallyEdited = `\uFEFF${reviewSource.replace("Closing line.", "Disk closing.")}`;
    await writeFile(draft, externallyEdited);
    await waitForView(
      "the external change during generation",
      "return document.querySelector('.cm-content')?.textContent.includes('Disk closing.');",
    );
    await nativeShortcut("ctrl+n");
    await waitForView(
      "the second document to have focus before the native model completes",
      "return document.querySelector('[role=tab][aria-selected=true]')?.textContent === 'Untitled' && document.activeElement?.matches('.cm-content');",
    );
    previewReply.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "<replacement>**Revised opening.**\n\nKeep this.  \n\nRevised closing.</replacement>",
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
    await waitForView(
      "a passive completion notice while the second editor retains focus",
      `const notice = document.querySelector('[aria-label="Writing task notifications"]');
       return notice?.innerText.includes('2 decisions needed') &&
         document.querySelector('[role=tab][aria-selected=true]')?.textContent === 'Untitled' &&
         document.activeElement?.matches('.cm-content');`,
    );
    await clickPath(
      "//section[@aria-label='Writing task notifications']//button[normalize-space(.)='Open task for ask-ai-model.md']",
    );
    await waitForView(
      "independent rendered proposals with the changed text compared",
      `return [...document.querySelectorAll('[aria-label="Proposed edit 1 of 2"] strong')]
          .some((node) => node.textContent === 'Revised opening.') &&
        document.querySelector('[aria-label="Proposed edit 2 of 2"]')?.innerText.includes('Disk closing.');`,
    );
    assert.equal(await readFile(draft, "utf8"), externallyEdited);
    const first = "//fieldset[@aria-label='Proposed edit 1 of 2']";
    const second = "//fieldset[@aria-label='Proposed edit 2 of 2']";
    await clickPath(`${first}//button[normalize-space(.)='Apply proposed edit']`);
    await clickPath(`${second}//button[normalize-space(.)='Dismiss proposed edit']`);
    await until(
      "only the accepted native change to be autosaved",
      async () =>
        (await readFile(draft, "utf8")) ===
          externallyEdited.replace("Opening line.", "Revised opening.") || null,
    ).catch(explain);
    await clickPath("//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Close']");
    await keyActions(chord(keys.control, "z"));
    await until(
      "undo to preserve the external edit",
      async () => (await readFile(draft, "utf8")) === externallyEdited || null,
    ).catch(explain);

    await keyActions(chord(keys.control, "a"));
    await askSelection(stopInstruction);
    await showsIn('section[aria-label="Ask AI"]', "Native partial text.");
    await clickPath("//*[@role='tab' and normalize-space(.)='Untitled']");
    await waitForView(
      "the second document to have focus during native streaming",
      "return document.querySelector('[role=tab][aria-selected=true]')?.textContent === 'Untitled' && document.activeElement?.matches('.cm-content');",
    );
    await clickPath("//section[@aria-label='Writing tasks']//summary");
    await clickPath(
      "//section[@aria-label='Writing tasks']//button[normalize-space(.)='Stop generation']",
    );
    await until("Stop to close the unfinished HTTP response", async () => stopped || null).catch(
      explain,
    );
    await clickPath(
      "//section[@aria-label='Writing tasks']//button[normalize-space(.)='Open task for ask-ai-model.md']",
    );
    await showsIn('aside[aria-label="Writing Assistant"]', "Native partial text.");
    await clickPath(
      "//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Apply proposed edit']",
    );
    await until(
      "only the complete native edit to be autosaved",
      async () => (await readFile(draft, "utf8")) === "\uFEFFReady to review." || null,
    ).catch(explain);
    await keyActions(chord(keys.control, "z"));
    await until(
      "undo to restore the native baseline before retry",
      async () => (await readFile(draft, "utf8")) === externallyEdited || null,
    ).catch(explain);
    await clickPath(
      "//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Retry generation']",
    );
    await waitForView(
      "the native retry to finish with no duplicate proposal",
      `const sidebar = document.querySelector('aside[aria-label="Writing Assistant"]');
        return sidebar && !sidebar.innerText.includes('Generating') &&
          ![...sidebar.querySelectorAll('button')].some((button) =>
            ['Retry generation', 'Apply proposed edit'].includes(button.textContent.trim()));`,
    );
    assert.deepEqual(requests.at(-1), requests.at(-2), "retry sent the original native request");
    assert.equal(await readFile(draft, "utf8"), externallyEdited);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

test("a saved writing review resumes after a native restart without contacting its model", async () => {
  const draft = join(dir, "resume-writing-review.md");
  const renamedDraft = join(dir, "renamed-writing-review.md");
  const background = Array.from({ length: 40 }, (_, index) => `Background ${index + 1}.`).join(
    "\n\n",
  );
  const original = `# Methods\n\n| Group | Finding |\n| --- | --- |\n| Coast | First draft. |\n\nSecond draft.\n\nThird draft.\n\nFourth draft.\n\nFifth draft.\n\n# Results\n\n${background}\n\nLast draft.`;
  const replacement = original.replaceAll("draft.", "edit.");
  const instruction = "Review all six passages.";
  const excerpt = "The Tuesday field notes support the first passage.";
  const note = "Check this with the interviewer.";
  const requests: { messages: { content: string }[] }[] = [];
  let connectionId: string | undefined;
  const savedReviewWithPending = (count: number) =>
    until(`the saved writing review to have ${count} pending decisions`, async () => {
      const [task] = await invokeNative<SavedWritingTask[]>("list_writing_tasks", { path: draft });
      if (!task) return null;
      const suggestions = task.turns[0]?.suggestions;
      return suggestions?.filter(({ status }) => status === "preview").length === count
        ? task
        : null;
    }).catch(explain);
  await writeFile(draft, original);
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: { content: `<replacement>${replacement}</replacement>` },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    await restart([draft]);
    connectionId = (
      await invokeNative<{ id: string }>("save_model_connection", {
        connection: {
          name: "Review recovery fixture",
          address: `http://127.0.0.1:${address.port}/v1`,
          model: "native-review-recovery",
          apiKey: "",
          lifetime: "persistent",
        },
      })
    ).id;
    await waitForView(
      "the review manuscript to open",
      "return document.activeElement?.matches('.cm-content');",
    );
    await keyActions(chord(keys.control, "a"));
    await click("Ask AI");
    await waitForView(
      "the recovery model to be selected",
      `
      const option = [...document.querySelectorAll('section[aria-label="Ask AI"] select option')]
        .find(item => item.label.startsWith('Review recovery fixture'));
      if (!option) return false;
      option.parentElement.value = option.value;
      option.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `,
    );
    await addPastedWritingMaterial(excerpt);
    await clickPath(
      "//section[@aria-label='Ask AI']//label[normalize-space(.)='Instruction']/input",
    );
    await keyActions([...typing(instruction), ...typing(keys.enter)]);
    await waitForView(
      "the review proposal to arrive",
      "return [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Review proposed edits');",
    );
    await waitForView(
      "the manuscript to regain keyboard focus after sending",
      "return document.activeElement?.matches('.cm-content');",
    );
    await keyActions(chord(keys.control, keys.end));
    await waitForView(
      "the manuscript to scroll to its last paragraph",
      "return document.querySelector('.cm-scroller')?.scrollTop > 0;",
    );
    await tabToView(
      "the proposed edits button",
      `return document.activeElement?.matches('section[aria-label="Ask AI"] button') &&
        document.activeElement.textContent.trim() === 'Review proposed edits';`,
    );
    await keyActions(typing(keys.enter));
    const reviewRoot =
      "document.querySelector('dialog[open][aria-label=\"Review proposed edits\"]')";
    const focusedEdit = (number: number, type = "Replacement") =>
      waitForView(
        `proposal ${number} to receive keyboard focus`,
        `return ${reviewRoot}?.querySelector('h3') === document.activeElement &&
          document.activeElement.textContent.trim() === '${type} · Edit ${number} of 6';`,
      );
    const pressReviewButton = async (label: string) => {
      await tabToView(
        label,
        `return ${reviewRoot}?.contains(document.activeElement) &&
          document.activeElement?.matches('button') &&
          document.activeElement.textContent.trim() === ${JSON.stringify(label)};`,
      );
      await keyActions(typing(keys.enter));
    };
    await focusedEdit(1, "Table · Replacement");
    await waitForView(
      "both versions of the table to render in the native review",
      `const review = ${reviewRoot};
        return review?.querySelector('[aria-label="Removed text"] table')?.textContent.includes('First draft.') &&
          review?.querySelector('[aria-label="Added text"] table')?.textContent.includes('First edit.');`,
    );
    await pressReviewButton("Apply proposed edit");
    await focusedEdit(2);
    await pressReviewButton("Dismiss proposed edit");
    await focusedEdit(3);
    await pressReviewButton("Leave comment");
    await waitForView(
      "the review comment to receive keyboard focus",
      `return ${reviewRoot}?.querySelector('form input') === document.activeElement;`,
    );
    await keyActions([...typing(note), ...typing(keys.enter)]);
    await focusedEdit(4);
    await tabToView(
      "the Section selector",
      `const active = document.activeElement;
       return ${reviewRoot}?.contains(active) && active?.matches('select') &&
         active.options[0].textContent.trim() === 'All sections';`,
    );
    await keyActions(typing("m"));
    await pressReviewButton("Accept remaining edits in Methods");
    await shows("Accepted 2 edits.");
    await keyActions(typing(keys.escape));
    assert.deepEqual(JSON.parse(requests[0]?.messages.at(-1)?.content ?? ""), {
      instruction,
      selectedText: original,
      taskContext: { materials: [{ name: "Pasted text", text: excerpt }] },
    });
    await waitForView(
      "the manuscript to regain focus at the original reading position",
      `
      const editor = document.querySelector('.cm-content');
      const node = window.getSelection()?.focusNode;
      const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line');
      return editor === document.activeElement && line?.textContent === 'Last draft.';
    `,
    );
    const accepted = original.replace("First draft.", "First edit.");
    const batch = accepted
      .replace("Fourth draft.", "Fourth edit.")
      .replace("Fifth draft.", "Fifth edit.");
    await nativeShortcut("ctrl+s");
    await until(
      "only the two remaining Methods edits to reach disk",
      async () => (await readFile(draft)).equals(Buffer.from(batch)) || null,
    ).catch(explain);
    await savedReviewWithPending(2);
    await keyActions(chord(keys.control, "z"));
    await nativeShortcut("ctrl+s");
    await until(
      "one undo to restore both Methods edits and preserve the earlier acceptance",
      async () => (await readFile(draft, "utf8")) === accepted || null,
    ).catch(explain);
    const history = await until(
      "the batch and its undo to be recorded in version history",
      async () => {
        const versions = await invokeNative<number[]>("list_versions", { path: draft });
        const [batchId, undoId] = versions.slice(-2);
        if (batchId === undefined || undoId === undefined) return null;
        const savedBatch = await invokeNative<string>("read_version", { path: draft, id: batchId });
        const savedUndo = await invokeNative<string>("read_version", { path: draft, id: undoId });
        return savedBatch === batch && savedUndo === accepted ? versions : null;
      },
    ).catch(explain);
    const review = await savedReviewWithPending(4);
    assert.equal(review.reading.anchor, accepted.length, "the stored anchor stays at Last draft.");
    assert.equal(review.reading.head, accepted.length, "the stored caret stays at Last draft.");
    const links = await invokeNative<{ id: string; path: string; title: string }[]>(
      "list_writing_reviews_in_folder",
      { folder: dirname(draft) },
    );
    assert.ok(
      links.some(
        (link) => link.id === review.id && link.path === draft && link.title === instruction,
      ),
    );
    await assert.rejects(
      invokeNative("update_writing_task", { task: review, expectedUpdatedAt: 0 }),
      /writing task changed/,
    );
    await invokeNative("rename_path", { from: draft, to: renamedDraft });
    await stopSession();
    const changed = accepted.replace("Third draft.", "External third.");
    await writeFile(renamedDraft, changed);
    await restart([renamedDraft]);
    await click("Writing tasks");
    await click(instruction);
    await waitForView(
      "the saved decisions and only the changed proposal marked for comparison",
      `
      const pane = document.querySelector('aside[aria-label="Writing Assistant"]');
      const field = index => pane?.querySelector('fieldset[aria-label="Proposed edit ' + index + ' of 6"]');
      const button = (index, label) => [...field(index)?.querySelectorAll('button') ?? []].some(el => el.textContent.trim() === label);
      return field(1)?.innerText.includes('Applied to the selected text.') &&
        field(2)?.innerText.includes('Proposed edit dismissed.') &&
        field(3)?.innerText.includes('External third.') &&
        field(3)?.innerText.includes(${JSON.stringify(note)}) && button(3, 'Apply to compared text') &&
        [4, 5, 6].every(index => button(index, 'Apply proposed edit'));
    `,
    );
    await clickPath(
      "//aside[@aria-label='Writing Assistant']//summary[normalize-space(.)='Pasted text']",
    );
    await showsIn('aside[aria-label="Writing Assistant"]', excerpt);
    await clickPath(
      "//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Review proposed edits']",
    );
    await focusedEdit(4);
    await keyActions(typing(keys.escape));
    assert.equal(requests.length, 1);
    await waitForView(
      "the saved reading position",
      `
      const node = window.getSelection()?.focusNode;
      const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line');
      return line?.textContent === 'Last draft.';
    `,
    );
    await nativeShortcut("ctrl+w");
    await nativeShortcut("ctrl+n");
    await runPaletteCommand("All writing tasks");
    await waitForView(
      "the closed document's task and outstanding decisions in All writing tasks",
      `const dialog = document.querySelector('dialog[aria-label="All writing tasks"]');
       return [...dialog?.querySelectorAll('li') ?? []].some(row =>
         row.innerText.includes(${JSON.stringify(instruction)}) &&
         row.innerText.includes('renamed-writing-review.md') &&
         row.innerText.includes('4 decisions needed'));`,
    );
    await clickPath(
      `//dialog[@aria-label='All writing tasks']//button[normalize-space(.)='${instruction}']`,
    );
    await waitForView(
      "the task to open its manuscript and saved review",
      `return document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('renamed-writing-review.md') &&
        !!document.querySelector('aside[aria-label="Writing Assistant"] [aria-label="Proposed edit 4 of 6"]');`,
    );
    assert.equal(requests.length, 1, "finding a task does not send another native model request");
    assert.equal(await readFile(renamedDraft, "utf8"), changed);
    assert.deepEqual(
      await invokeNative<number[]>("list_versions", { path: renamedDraft }),
      history,
    );
    const second = "//fieldset[@aria-label='Proposed edit 2 of 6']";
    await clickPath(`${second}//button[normalize-space(.)='Return to pending']`);
    await waitForView(
      "only the chosen dismissal to return to pending from the saved task",
      `const pane = document.querySelector('aside[aria-label="Writing Assistant"]');
       const edit = index => pane?.querySelector('fieldset[aria-label="Proposed edit ' + index + ' of 6"]');
       return edit(1)?.innerText.includes('Applied to the selected text.') &&
         [...edit(2)?.querySelectorAll('button') ?? []].some(el => el.textContent.trim() === 'Apply proposed edit') &&
         edit(3)?.innerText.includes(${JSON.stringify(note)});`,
    );
    assert.equal(await readFile(renamedDraft, "utf8"), changed);
    const overlapping = changed.replace("First edit.", "Author's first edit.");
    await writeFile(renamedDraft, overlapping);
    await waitForView(
      "the later author edit to load from disk",
      `const tab = document.querySelector('[role=tab][aria-selected=true]');
       const panel = document.getElementById(tab?.getAttribute('aria-controls'));
       return tab?.textContent === 'renamed-writing-review.md' &&
         panel?.querySelector('.cm-content')?.textContent.includes("Author's first edit.");`,
    );
    await click("Open renamed-writing-review.md in other pane", "aria-label");
    await click("Writing tasks");
    await click(instruction);
    const first = "//fieldset[@aria-label='Proposed edit 1 of 6']";
    await clickPath(`${first}//button[normalize-space(.)='Revert to selected text']`);
    await showsIn(
      'aside[aria-label="Writing Assistant"] fieldset[aria-label="Proposed edit 1 of 6"]',
      "Edit reverted.",
    );
    await clickPath("//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Close']");
    // Each pane renders only the Markdown near its own reading position.
    const panes = "[role=tabpanel]:not([hidden]) .cm-content";
    for (const index of [0, 1]) {
      await waitForView(
        `native editor pane ${index + 1} to receive focus`,
        `const editors = document.querySelectorAll(${JSON.stringify(panes)});
         if (editors.length !== 2) return false;
         editors[${index}].focus();
         return editors[${index}] === document.activeElement;`,
      );
      await keyActions(chord(keys.control, keys.home));
    }
    await waitForView(
      "both native panes to show the chosen reversion and preserve the external edit",
      `const panes = [...document.querySelectorAll(${JSON.stringify(panes)})];
      return panes.length === 2 && panes.every(pane =>
        pane.textContent.includes('First draft.') && pane.textContent.includes('External third.'));`,
    );
    await nativeShortcut("ctrl+s");
    await until(
      "reverting an accepted proposal from the restored task to preserve the external edit",
      async () =>
        (await readFile(renamedDraft, "utf8")) === changed.replace("First edit.", "First draft.") ||
        null,
    ).catch(explain);
    assert.equal(requests.length, 1);
  } finally {
    try {
      if (connectionId && session)
        await invokeNative("disconnect_model_connection", { id: connectionId });
    } finally {
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  }
});

test("inline completion sends the live manuscript excerpt through the native model connection", async () => {
  const draft = join(dir, "inline-completion.md");
  const initial = "\uFEFF# Route\r\n\r\nThe";
  const continuation = " leads to the ridge.";
  const name = "Completion fixture";
  let endpointOffline = false;
  let previousSettings: Record<string, unknown> | undefined;
  const selectAndSave = async (setting: string, label: string, key: string) => {
    const value = await chooseSettingsOption(setting, label);
    await until(`${setting} to reach disk`, async () => {
      const { values } = await invokeNative<{ values?: Record<string, unknown> }>(
        "read_settings",
        {},
      );
      return values?.[key] === value || null;
    }).catch(explain);
  };
  const setCompletion = (label: string) =>
    selectAndSave("Inline completion", label, "inlineCompletionModel");
  const typeInManuscript = async (text: string) => {
    await clickPath("//main//div[@role='textbox']");
    await nativeShortcut("ctrl+End");
    // CodeMirror requires focus in the top-level document, as well as its content element.
    await waitForView(
      "the native window and manuscript editor to have keyboard focus",
      "return document.hasFocus() && document.activeElement?.matches('.cm-content');",
    );
    await exec("xdotool", ["type", "--clearmodifiers", "--", text], { timeout: 5000 });
  };
  await writeFile(draft, initial);
  const requests: {
    method?: string;
    path?: string;
    authorization?: string;
    body: { model: string; stream: boolean; messages: { role: string; content: string }[] };
  }[] = [];
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    if (endpointOffline) {
      response.destroy();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [{ message: { content: continuation }, finish_reason: "stop" }],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    await restart([draft]);
    await waitForActiveDocument(draft);
    const settings = await invokeNative<{ values?: Record<string, unknown> }>("read_settings", {});
    previousSettings = settings.values ?? {};
    await openSettings();
    await click("Model connections");
    for (const [label, value] of [
      ["API address", `http://127.0.0.1:${address.port}/v1`],
      ["Model name", "completion-fixture"],
      ["API key", "mint-smoke-completion-fixture"],
      ["Connection name", name],
    ] as const) {
      await clickPath(`//dialog[@open]//label[normalize-space(.)='${label}']/input`);
      await keyActions(typing(value));
    }
    await clickPath("//button[not(@disabled) and normalize-space(.)='Use for this launch']");
    await selectAndSave("Default writing connection", name, "defaultWritingConnection");
    await setCompletion("Use the default writing connection");
    await clickSettingsButton("Run sample", "Inline completion");
    await shows(continuation.trim());
    const [sample] = requests.splice(0);
    assert.ok(sample);
    assert.equal(sample.path, "/v1/chat/completions");
    assert.equal(sample.body.model, "completion-fixture");
    assert.deepEqual(
      sample.body.messages.filter(({ role }) => role === "user"),
      [{ role: "user", content: '{"before":"The path follows the","after":""}' }],
    );
    await clickSettingsButton("Close");
    await typeInManuscript(" trail");
    await until(
      "the live excerpt to reach the model receiver",
      async () => requests[0] ?? null,
    ).catch(explain);
    await until("the inline suggestion at the focused editor", () =>
      command<string>("POST", `/session/${session}/execute/sync`, {
        script:
          "return document.activeElement.querySelector('.cm-mint-inline-completion')?.textContent",
        args: [],
      }).then((text) => (text === continuation ? text : null)),
    ).catch(explain);
    assert.equal(requests.length, 1);
    const [sent] = requests;
    assert.ok(sent);
    assert.equal(sent.method, "POST");
    assert.equal(sent.path, "/v1/chat/completions");
    assert.equal(sent.authorization, "Bearer mint-smoke-completion-fixture");
    assert.equal(sent.body.model, "completion-fixture");
    assert.equal(sent.body.stream, false);
    assert.deepEqual(
      sent.body.messages.filter(({ role }) => role === "user"),
      [{ role: "user", content: JSON.stringify({ before: "# Route\n\nThe trail", after: "" }) }],
    );
    assert.ok(!(await readFile(draft, "utf8")).includes(continuation));

    await nativeShortcut("Tab");
    await nativeShortcut("ctrl+s");
    await until(
      "Tab to save the continuation with the original line endings",
      async () => (await readFile(draft, "utf8")) === `${initial} trail${continuation}` || null,
    ).catch(explain);

    await openSettings();
    await setCompletion("Off");
    await clickSettingsButton("Close");
    await typeInManuscript(" Today.");
    await nativeShortcut("ctrl+s");
    await until(
      "writing after switching inline completion off",
      async () =>
        (await readFile(draft, "utf8")) === `${initial} trail${continuation} Today.` || null,
    ).catch(explain);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(requests.length, 1, "switching inline completion off stops subsequent requests");

    await openSettings();
    await setCompletion("Use the default writing connection");
    await clickSettingsButton("Close");
    endpointOffline = true;
    await typeInManuscript(" Still writing.");
    await waitForView(
      "the native local connection failure with the author's typing intact",
      `return document.querySelector('section[aria-label="Inline completion"]')?.innerText.includes('Local model is unreachable') &&
        document.querySelector('.cm-content:focus')?.textContent.includes('Still writing.');`,
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.body.model, "completion-fixture");
    await nativeShortcut("ctrl+s");
    await until(
      "the author's typing to save after the local connection failure",
      async () =>
        (await readFile(draft, "utf8")) ===
          `${initial} trail${continuation} Today. Still writing.` || null,
    ).catch(explain);
  } finally {
    try {
      if (previousSettings) await invokeNative("write_settings", { values: previousSettings });
    } finally {
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  }
});

test("automatic proofreading sends only the active passage and undo restores the native file", async () => {
  const path = join(dir, "proofreading.md");
  const original = "\uFEFFA speeling error.  \r\n\r\nPrivate appendix.\n";
  await writeFile(path, original);
  const requests: { url?: string; authorization?: string; body: unknown }[] = [];
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: { content: '{"original":"speeling","replacement":"spelling"}' },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.listen(0, "127.0.0.1", resolve);
  });
  const address = endpoint.address();
  assert.ok(address && typeof address !== "string");
  const api = `http://127.0.0.1:${address.port}/v1`;
  const secret = "native-proofreading-fixture-key";
  const checkbox =
    "//input[@type='checkbox' and @id=//label[normalize-space(.)='Automatic proofreading']/@for]";

  try {
    await restart([path]);
    await waitForActiveDocument(path);
    await openSettings();
    await click("Model connections");
    await shows("Sample prompt");
    for (const [label, value] of [
      ["Connection name", "Native proofreading fixture"],
      ["API address", api],
      ["Model name", "native-proofreader"],
      ["API key", secret],
    ]) {
      const input = await command<Record<string, string>>("POST", `/session/${session}/element`, {
        using: "xpath",
        value: `//dialog[@open]//label[normalize-space(.)='${label}']/input`,
      });
      await command("POST", `/session/${session}/element/${input[elementKey]}/value`, {
        text: value,
      });
    }
    await clickPath("//button[not(@disabled) and normalize-space(.)='Use for this launch']");
    await chooseSettingsOption("Proofreading model", "Native proofreading fixture");
    assert.equal(requests.length, 0, "setting up a model does not send the manuscript");
    await clickPath(checkbox);
    await click("Close");
    await clickPath("//div[contains(@class,'cm-line') and normalize-space(.)='A speeling error.']");
    await keyActions(typing(keys.home));
    const { url, authorization, body } = await until(
      "the active passage to reach the native proofreading model",
      async () => requests[0] ?? null,
    ).catch(explain);
    assert.equal(url, "/v1/chat/completions");
    assert.equal(authorization, `Bearer ${secret}`);
    const { model, messages } = body as { model: string; messages: { content: string }[] };
    assert.equal(model, "native-proofreader");
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.ok(message);
    assert.equal(JSON.parse(message.content).selectedText, "A speeling error.");
    await clickPath(
      "//section[@aria-label='Proofreading suggestion']//button[normalize-space(.)='Apply correction']",
    );
    await nativeShortcut("ctrl+s");
    await until(
      "only the corrected fragment to reach disk",
      async () =>
        (await readFile(path, "utf8")) === original.replace("speeling", "spelling") || null,
    ).catch(explain);
    await keyActions(chord(keys.control, "z"));
    await nativeShortcut("ctrl+s");
    await until(
      "Undo to restore the exact native bytes",
      async () => (await readFile(path)).equals(Buffer.from(original)) || null,
    ).catch(explain);

    await openSettings();
    await clickPath(checkbox);
    await click("Close");
    const sentBeforeTyping = requests.length;
    await clickPath("//main//div[@role='textbox']");
    await keyActions([...typing(keys.end), ...typing(" More notes.")]);
    await nativeShortcut("ctrl+s");
    await until(
      "ordinary writing to reach disk after turning proofreading off",
      async () => (await readFile(path, "utf8")).includes("More notes.") || null,
    ).catch(explain);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(requests.length, sentBeforeTyping);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

test("read-only document review receives native model findings and preserves manuscript bytes", async () => {
  const path = join(dir, "annotation-review.md");
  const original = "\uFEFFOpening paragraph.  \r\n\r\nSource notes.\n";
  await writeFile(path, original);
  const requests: { url?: string; authorization?: string; body: string }[] = [];
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    quote: "Source notes.",
                    note: "Name the source.",
                    replacement: "Do not write.",
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.listen(0, "127.0.0.1", resolve);
  });
  const address = endpoint.address();
  assert.ok(address && typeof address !== "string");
  const secret = "native-annotation-review-fixture-key";
  try {
    await restart([path]);
    await openSettings();
    await click("Model connections");
    await shows("Sample prompt");
    for (const [label, value] of [
      ["Connection name", "Native annotation review fixture"],
      ["API address", `http://127.0.0.1:${address.port}/v1`],
      ["Model name", "native-annotation-reviewer"],
      ["API key", secret],
    ]) {
      const input = await command<Record<string, string>>("POST", `/session/${session}/element`, {
        using: "xpath",
        value: `//dialog[@open]//label[normalize-space(.)='${label}']/input`,
      });
      await command("POST", `/session/${session}/element/${input[elementKey]}/value`, {
        text: value,
      });
    }
    await clickSettingsButton("Use for this launch");
    await click("Close");
    await clickPath("//footer//button[normalize-space(.)='Annotations']");
    await click("Review Document (Read Only)…");
    await waitForView(
      "the read-only review recipient",
      `const option = [...document.querySelectorAll('aside[aria-label="Annotations"] select option')]
        .find(item => item.textContent.startsWith("Native annotation review fixture · "));
        if (!option) return false;
        option.parentElement.value = option.value;
        option.parentElement.dispatchEvent(new Event("change", { bubbles: true }));
        return true;`,
    );
    assert.equal(requests.length, 0);
    await clickPath(
      "//aside[@aria-label='Annotations']//button[@type='submit' and not(@disabled) and contains(.,'Comment only') and contains(.,'Native annotation review fixture')]",
    );
    await waitForView(
      "the native finding to appear as an annotation",
      `return document.querySelector('aside[aria-label="Annotations"] section[aria-label="Pending"]')?.innerText.includes("Name the source.");`,
    );
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request?.url, "/v1/chat/completions");
    assert.equal(request?.authorization, `Bearer ${secret}`);
    const body = JSON.parse(request?.body ?? "");
    assert.equal(body.model, "native-annotation-reviewer");
    const sent = JSON.parse(body.messages.at(-1).content);
    assert.deepEqual(Object.keys(sent).sort(), ["instruction", "selectedText"]);
    assert.equal(sent.selectedText, original.slice(1));
    await clickPath(
      "//aside[@aria-label='Annotations']//button[normalize-space(.)='Go to target']",
    );
    await waitForView(
      "the original native excerpt to be selected",
      `return getSelection()?.toString() === "Source notes.";`,
    );
    await nativeShortcut("ctrl+s");
    await waitForView(
      "the reviewed manuscript to remain saved",
      "return document.querySelector('footer button[aria-label=\"Version History\"]')?.textContent === 'Saved';",
    );
    assert.deepEqual(await readFile(path), Buffer.from(original));
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

test("a native model reply stays editable and untitled until the author chooses a Save As path", async () => {
  const folder = await mkdtemp(join(homedir(), "mint-ai-draft-"));
  const sources = join(folder, "sources");
  const source = join(sources, "field-log.md");
  const pdf = join(sources, "deck-observations.pdf");
  const excerpt = "The north ridge reopened on Tuesday.";
  const revision = "The north ridge will remain closed until Friday.";
  const unapproved = "Private crew contact details.";
  await mkdir(sources);
  await writeFile(source, `${unapproved}\n${excerpt}\n`);
  await writeFile(pdf, writingMaterialPdf());
  const path = join(folder, "field-notes.md");
  const instruction = "Draft an introduction for the field notes.";
  const supported = "The north ridge is open again.";
  const unsupported = "The south trail is open too.";
  const deckClaim = "The observation deck opens Tuesday.";
  const generated = `${supported} ${unsupported} ${deckClaim}`;
  const groundedReply = `${generated}\n\n<source-passages>\n${JSON.stringify([
    { claim: supported, material: 3, quote: excerpt },
    { claim: unsupported, material: 3, quote: unapproved },
    { claim: deckClaim, material: 2, quote: selectedPageText },
  ])}\n</source-passages>`;
  const requests: {
    path: string | undefined;
    method: string | undefined;
    authorization: string | undefined;
    body: { model: string; stream: boolean; messages: { role: string; content: string }[] };
  }[] = [];
  const endpoint = createServer(async (request, response) => {
    let input = "";
    for await (const chunk of request) input += chunk;
    requests.push({
      path: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      body: JSON.parse(input),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    const content =
      requests.length === 1
        ? JSON.stringify({
            requestMaterial: {
              name: "Trail log",
              purpose: "Confirm when the ridge reopened.",
              query: "north ridge reopened",
            },
          })
        : requests.length === 2
          ? groundedReply
          : JSON.stringify([{ id: 1, assessment: "The revised log contradicts this statement." }]);
    response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  });

  const draftMatches = (text: string) =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `const [text] = arguments;
        const tab = document.querySelector('[role=tab][aria-selected=true]');
        const editor = document.getElementById(tab?.getAttribute('aria-controls'))?.querySelector('.cm-content');
        return tab?.textContent === 'Untitled' && editor?.textContent === text;`,
      args: [text],
    }).then((ready) => ready || null);

  try {
    await new Promise<void>((resolve, reject) => {
      endpoint.once("error", reject);
      endpoint.listen(0, "127.0.0.1", resolve);
    });
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    await restart([sources, document]);
    await waitForActiveDocument(document);
    await nativeShortcut("ctrl+n");
    await click("Draft with AI");
    await chooseCustomDraftConnection();

    for (const [label, value] of [
      ["API address", `http://127.0.0.1:${address.port}/v1`],
      ["Model name", "native-draft-fixture"],
      ["API key (optional, for this draft)", "draft-fixture-secret"],
      ["Drafting instruction", instruction],
    ] as const) {
      await clickPath(`//form//label[normalize-space(.)='${label}']/input`);
      await keyActions(typing(value));
    }
    await addPastedWritingMaterial("Field notes are for the visitor bulletin.");
    await chooseWebViewFile("Choose material file", pdf, "body");
    await clickPath(
      "//form//fieldset[legend='deck-observations.pdf']//label[normalize-space(text()[1])='PDF page']/input",
    );
    await keyActions([...chord(keys.control, "a"), ...typing("2")]);
    await clickPath(
      "//form//fieldset[legend='deck-observations.pdf']//button[not(@disabled) and normalize-space(.)='Use selected material']",
    );
    await showsIn("form", "deck-observations.pdf · Page 2 of 2 · Extracted text");
    await clickPath(
      "//form//label[normalize-space(.)='Allow searching the current working folder']/input",
    );
    await clickPath("//form//button[not(@disabled) and normalize-space(.)='Generate draft']");
    await waitForView(
      "the model's purpose and the actual native folder excerpt",
      `const text = document.querySelector('fieldset[aria-label="Additional material requested"]')?.innerText;
        return text?.includes('Confirm when the ridge reopened.') &&
          text.includes('The north ridge reopened on Tuesday.') &&
          !text.includes('Private crew contact details.');`,
    );
    assert.equal(requests.length, 1, "the excerpt waits for authorization");
    await clickPath(
      "//form//label[.//input[@type='radio' and @aria-label='field-log.md · line 2']]",
    );
    await clickPath("//form//button[not(@disabled) and normalize-space(.)='Allow once']");
    await until("the generated Markdown in the untitled editor", () =>
      draftMatches(generated),
    ).catch(explain);
    const sourceReview = '//section[@aria-label="Source passages"]';
    const chooseClaim = `${sourceReview}//button[normalize-space(.)='${supported}']`;
    await clickPath(chooseClaim);
    await waitForView(
      "the approved original passage and the unverified conclusion",
      `const review = document.querySelector('section[aria-label="Source passages"]');
        const passage = review?.querySelector('section[aria-label="Excerpt used for this draft"]');
        return passage?.querySelector('blockquote')?.textContent === ${JSON.stringify(excerpt)} &&
          passage?.textContent.includes('field-log.md · line 2') &&
          [...review.querySelectorAll('li')].some((line) =>
            line.textContent.includes(${JSON.stringify(unsupported)}) &&
            line.textContent.includes('Needs verification')) &&
          !review.textContent.includes(${JSON.stringify(unapproved)});`,
    );
    assert.equal(requests.length, 2);
    const initialContext = {
      materials: [
        { name: "Pasted text", text: "Field notes are for the visitor bulletin." },
        {
          name: "deck-observations.pdf",
          text: selectedPageText,
          range: { kind: "pdf", page: 2, pages: 2 },
          format: "extractedText",
        },
      ],
      folderSearch: true,
    };
    for (const [index, request] of requests.entries()) {
      assert.equal(request.path, "/v1/chat/completions");
      assert.equal(request.method, "POST");
      assert.equal(request.authorization, "Bearer draft-fixture-secret");
      assert.equal(request.body.model, "native-draft-fixture");
      assert.equal(request.body.stream, true);
      assert.ok(
        request.body.messages.some(
          ({ role, content }) => role === "system" && content.includes("<source-passages>"),
        ),
      );
      assert.deepEqual(JSON.parse(request.body.messages.at(-1)?.content ?? ""), {
        instruction: `Write a Markdown draft following this instruction. Return only the draft text, without a surrounding code fence.\n\n${instruction}`,
        taskContext:
          index === 0
            ? initialContext
            : {
                ...initialContext,
                materialDecisions: [
                  {
                    name: "Trail log",
                    purpose: "Confirm when the ridge reopened.",
                    outcome: "allowed",
                    material: { name: "field-log.md · line 2", text: excerpt },
                  },
                ],
              },
      });
    }
    assert.equal(await readFile(source, "utf8"), `${unapproved}\n${excerpt}\n`);

    async function saveWith(action: "Cancel" | "Save") {
      await Promise.all([
        nativeShortcut("ctrl+s"),
        exec("/usr/bin/python3", ["smoke/choose-gtk-path.py", "Save As", path, action], {
          timeout: 60_000,
        }),
      ]);
    }
    await saveWith("Cancel");
    await until("the draft to remain after the save is cancelled", () =>
      draftMatches(generated),
    ).catch(explain);
    assert.deepEqual(await readdir(folder), ["sources"]);
    await clickPath("//*[@role='tabpanel' and not(@hidden)]//*[@contenteditable='true']");
    await keyActions([...typing(keys.end), ...typing(" Author's addition.")]);
    const edited = `${generated} Author's addition.`;
    await until("the author's addition in the draft", () => draftMatches(edited)).catch(explain);
    await saveWith("Save");
    assert.equal(await until("the saved draft", () => readFile(path, "utf8")), edited);
    const saved = await until("the draft task to follow the native Save As path", async () => {
      const tasks = await invokeNative<SavedWritingTask[]>("list_writing_tasks", { path });
      return tasks.find((task) => task.title === instruction) ?? null;
    });
    assert.equal(saved.turns[0]?.reply, generated);
    assert.deepEqual(saved.turns[0]?.sourcePassages, [
      {
        from: 0,
        claim: supported,
        excerpts: [
          {
            name: "field-log.md · line 2",
            quote: excerpt,
            line: 1,
            sourceFile: { path: source, line: 2 },
          },
        ],
      },
      { from: supported.length + 1, claim: unsupported, excerpts: [] },
      {
        from: generated.indexOf(deckClaim),
        claim: deckClaim,
        excerpts: [
          {
            name: "deck-observations.pdf",
            range: { kind: "pdf", page: 2, pages: 2 },
            format: "extractedText",
            quote: selectedPageText,
            line: 1,
          },
        ],
      },
    ]);
    assert.ok(!JSON.stringify(saved).includes("draft-fixture-secret"));
    await clickPath(`${sourceReview}//button[normalize-space(.)='Insert Markdown citation']`);
    await nativeShortcut("ctrl+s");
    const cited = `${supported}[^mint-source-1] ${unsupported} ${deckClaim} Author's addition.\n\n[^mint-source-1]: field-log.md · line 2, line 1 of sent material. “${excerpt}”\n`;
    await until(
      "only the requested citation to be added to the native manuscript",
      async () => (await readFile(path, "utf8")) === cited || null,
    );
    assert.equal(requests.length, 2);

    await writeFile(source, `${unapproved}\n${revision}\n`);
    await restart([sources, path]);
    await waitForActiveDocument(path);
    await invokeNative("save_model_connection", {
      connection: {
        name: "Source check fixture",
        address: `http://127.0.0.1:${address.port}/v1`,
        model: "native-source-check",
        apiKey: "source-check-fixture",
        lifetime: "session",
      },
    });
    await nativeShortcut("ctrl+shift+p");
    await waitForView(
      "the Command Palette to receive focus",
      `return document.activeElement?.matches('dialog[aria-label="Command Palette"] input');`,
    );
    await keyActions(typing("All writing tasks"));
    await shows("All writing tasks");
    await keyActions(typing(keys.enter));
    await clickPath(
      `//dialog[@aria-label='All writing tasks']//button[normalize-space(.)='${instruction}']`,
    );
    await clickPath(chooseClaim);
    await waitForView(
      "the original excerpt and the new on-disk source after restart",
      `const review = document.querySelector('section[aria-label="Source passages"]');
       const passage = review?.querySelector('section[aria-label="Excerpt used for this draft"]');
       const comparison = passage?.querySelector('section[aria-label="Source comparison"]');
       return passage?.querySelector('blockquote')?.textContent === ${JSON.stringify(excerpt)} &&
         comparison?.querySelector('blockquote')?.textContent === ${JSON.stringify(revision)};`,
    );
    assert.equal(requests.length, 2, "restoring and comparing a changed source makes no request");
    const affected = '//section[@aria-label="Affected statements"]';
    await waitForView(
      "the source check model to be selected",
      `const select = document.querySelector('section[aria-label="Affected statements"] select');
       const option = [...(select?.options ?? [])].find(item => item.label.startsWith('Source check fixture'));
       if (!option) return false;
       select.value = option.value;
       select.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`,
    );
    await clickPath(
      `${affected}//button[not(@disabled) and normalize-space(.)='Verify affected statements']`,
    );
    await waitForView(
      "the assessment next to the affected statement",
      `const affected = document.querySelector('section[aria-label="Affected statements"]');
       return affected?.textContent.includes('The revised log contradicts this statement.') &&
         affected.textContent.includes(${JSON.stringify(supported)}) &&
         !affected.textContent.includes(${JSON.stringify(unsupported)});`,
    );
    assert.equal(requests.length, 3);
    assert.equal(requests[2]?.path, "/v1/chat/completions");
    assert.equal(requests[2]?.authorization, "Bearer source-check-fixture");
    assert.equal(requests[2]?.body.model, "native-source-check");
    const check = JSON.parse(requests[2]?.body.messages.at(-1)?.content ?? "");
    assert.deepEqual(Object.keys(check).sort(), ["instruction", "selectedText"]);
    assert.deepEqual(JSON.parse(check.selectedText), [
      {
        id: 1,
        claim: supported,
        evidence: [{ source: "field-log.md · line 2", original: excerpt, revised: revision }],
      },
    ]);
    assert.equal(await readFile(path, "utf8"), cited);
    assert.equal(await readFile(source, "utf8"), `${unapproved}\n${revision}\n`);

    // Upload the same source after its second page has lost all text.
    await writeFile(pdf, writingMaterialPdf(""));
    await clickPath(`${sourceReview}//button[normalize-space(.)='${deckClaim}']`);
    await chooseWebViewFile("Choose revised source", pdf, "body");
    await waitForView(
      "the persisted PDF excerpt and its now blank page in the revised source",
      `const passage = document.querySelector('section[aria-label="Excerpt used for this draft"]');
       return passage?.querySelector('blockquote')?.textContent === ${JSON.stringify(selectedPageText)} &&
         passage.textContent.includes('deck-observations.pdf · Page 2 of 2 · Extracted text') &&
         passage.querySelector('section[aria-label="Source comparison"]')?.textContent
          .includes('The original excerpt no longer has text at this location.');`,
    );
    assert.equal(requests.length, 3, "comparing the revised PDF makes no request");
    assert.equal(await readFile(path, "utf8"), cited);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
});

async function addPastedWritingMaterial(text: string) {
  await waitForView(
    "the material picker to open",
    `const summary = [...document.querySelectorAll('form summary')]
      .find(item => item.textContent.trim() === 'Add files or paste text' && item.getClientRects().length);
     if (!summary) return false;
     if (!summary.parentElement.open) summary.click();
     return summary.parentElement.open;`,
  );
  await clickPath("//form//label[normalize-space(.)='Pasted material']/textarea");
  await keyActions(typing(text));
  await clickPath("//form//button[normalize-space(.)='Add pasted text']");
}

test("a slash writing skill sends the approved plan and remembers its folder action across native launches", async () => {
  const folder = await mkdtemp(join(dir, "writing-skills-"));
  const draft = join(folder, "skill-manuscript.md");
  const source = "The trails is open.";
  const revised = "The trails are open.";
  const material = "Trail is plural in this passage.";
  await writeFile(draft, source);
  const received: { path?: string; messages: { role: string; content: string }[] }[] = [];
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ path: request.url, messages });
    const editing = messages.some(({ content }: { content: string }) =>
      content.includes("<replacement>"),
    );
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: editing ? `<replacement>${revised}</replacement>` : "Use a plural verb.",
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.listen(0, "127.0.0.1", resolve);
  });
  const composer = 'section[aria-label="Ask AI"]';
  const action = `${composer} select:has(option[value="direct"])`;
  const chooseAction = (value: string) =>
    waitForView(
      `the ${value} action to be available`,
      `
    const select = document.querySelector(${JSON.stringify(action)});
    const option = [...(select?.options ?? [])].find(option => option.value === ${JSON.stringify(value)});
    if (!option || option.disabled) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `,
    );
  const chooseRecipient = () =>
    waitForView(
      "the loopback model to be available",
      `
    const select = [...document.querySelectorAll('${composer} label')]
      .find(label => label.firstChild?.textContent === 'Recipient')?.control;
    const option = [...(select?.options ?? [])].find(option => option.text.startsWith('Native skill fixture'));
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `,
    );
  const openSkill = async () => {
    await clickPath("//*[@role='treeitem' and @aria-label='skill-manuscript.md']");
    await clickPath("//div[contains(concat(' ', normalize-space(@class), ' '), ' cm-content ')]");
    await keyActions(chord(keys.control, "a"));
    await click("Ask AI");
    await clickPath(
      "//section[@aria-label='Ask AI']//label[normalize-space(.)='Instruction']/input",
    );
    await keyActions(typing("/copyedit"));
    await showsIn(composer, "Correct spelling, punctuation, and grammar.");
  };

  let connectionId: string | undefined;
  try {
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/v1`;
    await restart([folder, draft]);
    connectionId = (
      await invokeNative<{ id: string }>("save_model_connection", {
        connection: {
          name: "Native skill fixture",
          address: base,
          model: "native-skill",
          apiKey: "",
          lifetime: "persistent",
        },
      })
    ).id;

    await openSkill();
    await chooseRecipient();
    await chooseAction("comment");
    await click(`Remember this action for ${folder}`);
    await showsIn(composer, `Remembered for ${folder} · Comment only`);
    await addPastedWritingMaterial(material);
    assert.equal(received.length, 0, "inspecting and remembering a skill does not send material");
    await click(
      `Comment only · Current selection · Native skill fixture · ${base}/chat/completions`,
    );
    await waitForView(
      "the model's comment",
      `return document.querySelector('${composer} textarea[aria-label="AI reply"]')?.value === 'Use a plural verb.';`,
    );
    assert.equal(await readFile(draft, "utf8"), source);
    assert.equal(received[0]?.path, "/v1/chat/completions");
    const first = JSON.parse(received[0]?.messages.at(-1)?.content ?? "");
    assert.equal(first.selectedText, source);
    assert.deepEqual(first.taskContext, { materials: [{ name: "Pasted text", text: material }] });
    assert.match(first.instruction, /Correct spelling, punctuation, and grammar\./);
    assert.match(first.instruction, /Give comments only\./);

    await restart([folder, draft]);
    await openSkill();
    await showsIn(composer, `Remembered for ${folder} · Comment only`);
    await waitForView(
      "the remembered comment action after restart",
      `return document.querySelector(${JSON.stringify(action)})?.value === 'comment';`,
    );
    assert.equal(received.length, 1, "restoring a folder's action does not rerun the skill");
    await chooseRecipient();
    await chooseAction("direct");
    await click(
      `Apply directly · Current selection · Native skill fixture · ${base}/chat/completions`,
    );
    await showsIn(".cm-content", revised);
    await nativeShortcut("ctrl+s");
    await until(
      "the direct skill edit to reach disk",
      async () => (await readFile(draft, "utf8")) === revised || null,
    ).catch(explain);
    assert.equal(received.length, 2);
    const second = JSON.parse(received[1]?.messages.at(-1)?.content ?? "");
    assert.equal(second.selectedText, source);
    assert.match(second.instruction, /Revise the text\./);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    if (connectionId) await invokeNative("disconnect_model_connection", { id: connectionId });
  }
});

test("a shared writing skill uses fresh materials and the recipient's native connection", async () => {
  const folder = await mkdtemp(join(dir, "shared-writing-skill-"));
  const authorDraft = join(folder, "author-agreement.md");
  const recipientDraft = join(folder, "recipient-agreement.md");
  const exported = join(folder, "agreement-review.mint-skill.json");
  const source = "The authors is ready.";
  const theirText = "The reviewers is ready.";
  const oldMaterial = "Author's private writing material";
  const trialMaterial = "Fresh trial reference";
  const recipientMaterial = "Recipient's approved writing material";
  const authorKey = "fixture-author-key";
  const recipientKey = "fixture-recipient-key";
  const format = "Report each issue as a short bullet.";
  const received: {
    path?: string;
    authorization?: string;
    prompt: { instruction: string; selectedText?: string; taskContext?: unknown };
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({
      path: request.url,
      authorization: request.headers.authorization,
      prompt: JSON.parse(messages.at(-1).content),
    });
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [{ message: { content: "Check the subject and verb." }, finish_reason: "stop" }],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await writeFile(authorDraft, source);
  await writeFile(recipientDraft, theirText);
  const composer = "section[aria-label='Ask AI']";
  const fill = async (label: string, element: "textarea" | "input", value: string) => {
    await clickPath(
      `//section[@aria-label='Ask AI']//label[normalize-space(text()[1])='${label}']/${element}`,
    );
    await keyActions([...chord(keys.control, "a"), ...typing(value)]);
  };
  async function start(path: string, name: string, route: string, secret: string) {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/${route}/v1`;
    await restart([path]);
    await invokeNative("save_model_connection", {
      connection: {
        name,
        address: base,
        model: "skill-fixture",
        apiKey: secret,
        lifetime: "session",
      },
    });
    await clickPath("//div[contains(concat(' ', normalize-space(@class), ' '), ' cm-content ')]");
    await keyActions(chord(keys.control, "a"));
    return `Comment only · Current selection · ${name} · ${base}/chat/completions`;
  }
  const skillsMenu = () => nativeMenuItem("Edit", "Writing Skills…");
  const chooseRecipient = (name: string) =>
    waitForView(
      `the ${name} connection to be available`,
      `
      const select = [...document.querySelectorAll(${JSON.stringify(`${composer} label`)})]
        .find(label => label.firstChild?.textContent === 'Recipient')?.control;
      const option = [...(select?.options ?? [])]
        .find(option => option.text.startsWith(${JSON.stringify(name)}));
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `,
    );
  const expectReply = () =>
    waitForView(
      "the native model comment",
      `return document.querySelector(${JSON.stringify(`${composer} textarea[aria-label="AI reply"]`)})?.value === 'Check the subject and verb.';`,
    );

  try {
    const authorSend = await start(authorDraft, "Author skill fixture", "author", authorKey);
    await click("Ask AI");
    await fill("Instruction", "input", "/copyedit");
    await chooseRecipient("Author skill fixture");
    await showsIn(composer, "Correct spelling, punctuation, and grammar.");
    await waitForView(
      "comment-only action can be selected",
      `
      const select = document.querySelector("section[aria-label='Ask AI'] select:has(option[value='comment'])");
      if (!select) return false;
      select.value = 'comment';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `,
    );
    await addPastedWritingMaterial(oldMaterial);
    await click(authorSend);
    await expectReply();
    await click("Save as writing skill");
    await fill("Skill name", "input", "Agreement review");
    await fill("Result format", "textarea", format);
    // The inline skill form covers the editor's center. Focus the manuscript to select by keyboard.
    await waitForView(
      "the author manuscript to regain keyboard focus for the trial",
      `const editor = document.querySelector('[role=tabpanel]:not([hidden]) .cm-content');
       if (!editor) return false;
       editor.focus();
       return editor === document.activeElement;`,
    );
    await keyActions(chord(keys.control, "a"));
    await waitForView(
      "the fresh trial selection to be available",
      `const option = document.querySelector("section[aria-label='Ask AI'] select option[value='selection']");
       if (!option || option.disabled || getSelection()?.toString() !== ${JSON.stringify(source)})
         return false;
       option.parentElement.value = option.value;
       option.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`,
    );
    await addPastedWritingMaterial(trialMaterial);
    await clickPath(
      "//section[@aria-label='Ask AI']//button[starts-with(normalize-space(.), 'Trial run ·')]",
    );
    await showsIn(composer, "Trial result");
    assert.equal(received.length, 2);
    assert.equal(received[1]?.prompt.selectedText, source);
    assert.deepEqual(received[1]?.prompt.taskContext, {
      materials: [{ name: "Pasted text", text: trialMaterial }],
    });
    assert.equal(await readFile(authorDraft, "utf8"), source);
    await click("Save skill");
    await showsIn(composer, "Saved /agreement-review.");
    await clickPath("//section[@aria-label='Ask AI']//button[normalize-space(.)='Close']");
    await clickPath("//div[contains(concat(' ', normalize-space(@class), ' '), ' cm-content ')]");
    await keyActions(chord(keys.control, "a"));
    await skillsMenu();
    await click("/agreement-review · Agreement review");
    await chooseNativePath("Export skill", "Export skill", exported, "Save");
    const bytes = await until("the writing skill to be written", () =>
      readFile(exported, "utf8").catch(() => null),
    );
    assert.ok(bytes.includes("Correct spelling, punctuation, and grammar."));
    assert.ok(bytes.includes(format));
    for (const privateValue of [source, oldMaterial, trialMaterial, authorKey, "/author/v1"]) {
      assert.ok(!bytes.includes(privateValue));
    }

    const recipientSend = await start(
      recipientDraft,
      "Recipient skill fixture",
      "recipient",
      recipientKey,
    );
    await skillsMenu();
    await chooseWebViewFile("Import skill", exported, "body");
    await showsIn(composer, "Review imported skill");
    await showsIn(composer, "Material scope · Current selection");
    await showsIn(composer, "Default action · Comment only");
    await showsIn(composer, "This skill requires no tools.");
    assert.equal(received.length, 2);
    await click("Save skill");
    await click("/agreement-review-2 · Agreement review");
    await chooseRecipient("Recipient skill fixture");
    await addPastedWritingMaterial(recipientMaterial);
    await click(recipientSend);
    await expectReply();
    assert.equal(received.length, 3);
    assert.equal(received[0]?.authorization, `Bearer ${authorKey}`);
    assert.equal(received[2]?.authorization, `Bearer ${recipientKey}`);
    assert.equal(received[2]?.path, "/recipient/v1/chat/completions");
    const prompt = received[2]?.prompt;
    assert.equal(prompt?.selectedText, theirText);
    assert.deepEqual(prompt?.taskContext, {
      materials: [{ name: "Pasted text", text: recipientMaterial }],
    });
    assert.ok(prompt?.instruction.includes("Correct spelling, punctuation, and grammar."));
    assert.ok(prompt?.instruction.includes(format));
    assert.equal(await readFile(recipientDraft, "utf8"), theirText);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("native writing sends only the approved excerpt after a model capacity error", async () => {
  const publicLine = "Ridge is open.\n";
  const privateLine = "Private ranger contact details.";
  const received: { name: string; text: string }[][] = [];
  const endpoint = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { taskContext } = JSON.parse(JSON.parse(body).messages.at(-1).content);
    const materials = taskContext.materials as (typeof received)[number];
    received.push(materials);
    const oversized = Buffer.byteLength(materials.map(({ text }) => text).join("")) > 16;
    response.writeHead(oversized ? 400 : 200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        oversized
          ? { error: { code: "context_length_exceeded" } }
          : { choices: [{ message: { content: "Ridge bulletin." }, finish_reason: "stop" }] },
      ),
    );
  });

  try {
    await new Promise<void>((resolve, reject) => {
      endpoint.once("error", reject);
      endpoint.listen(0, "127.0.0.1", resolve);
    });
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const model = `http://127.0.0.1:${address.port}/v1`;
    await restart([document]);
    await waitForActiveDocument(document);
    await nativeShortcut("ctrl+n");
    await click("Draft with AI");
    await chooseCustomDraftConnection();
    for (const [label, value] of [
      ["API address", model],
      ["Model name", "bounded-native-fixture"],
      ["Drafting instruction", "Write a ridge bulletin."],
    ] as const) {
      await clickPath(`//form//label[normalize-space(.)='${label}']/input`);
      await keyActions(typing(value));
    }
    await clickPath("//form//summary[normalize-space(.)='Add files or paste text']");
    await clickPath("//form//label[normalize-space(.)='Pasted material']/textarea");
    await keyActions([
      ...typing(publicLine.trimEnd()),
      ...typing(keys.enter),
      ...typing(privateLine),
    ]);
    await click("Add pasted text");
    await clickPath("//form//button[not(@disabled) and normalize-space(.)='Generate draft']");
    await waitForView(
      "the capacity rejection in the draft form",
      `return [...document.querySelectorAll('form [role="alert"]')].some((notice) =>
        notice.textContent.includes("The recipient rejected the material because of its capacity."));`,
    );
    assert.deepEqual(received, [[{ name: "Pasted text", text: publicLine + privateLine }]]);

    await clickPath("//form//label[normalize-space(.)='Material limit (UTF-8 bytes)']/input");
    await keyActions(typing("16"));
    await waitForView(
      "the excerpt method to be selected",
      `const option = document.querySelector('form select option[value="excerpt"]');
        if (!option || !option.parentElement) return false;
        option.parentElement.value = option.value;
        option.parentElement.dispatchEvent(new Event("change", { bubbles: true }));
        return true;`,
    );
    await clickPath("//form//label[normalize-space(.)='Last line']/input");
    await keyActions(typing("1"));
    await waitForView(
      "the exact excerpt and loopback recipient before sending",
      `const plan = document.querySelector('section[aria-label="Material send plan"]');
        return plan?.innerText.includes("Excerpt · ${model}/chat/completions") &&
          plan.innerText.includes("Pasted text · lines 1–1") &&
          !plan.textContent.includes("Private ranger contact details.");`,
    );
    assert.equal(received.length, 1);
    await clickPath("//form//button[not(@disabled) and normalize-space(.)='Generate draft']");
    await waitForView(
      "the response to appear in the untitled editor",
      `return [...document.querySelectorAll('[role=tabpanel]:not([hidden]) .cm-content')]
        .some((editor) => editor.textContent === "Ridge bulletin.");`,
    );
    assert.deepEqual(received.slice(1), [[{ name: "Pasted text · lines 1–1", text: publicLine }]]);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

test("a native first model receives the selected PDF page and image crop as inline PNGs", async () => {
  const folder = await mkdtemp(join(dir, "material-ranges-"));
  const pdf = join(folder, "field-notes.pdf");
  const chart = join(folder, "chart.png");
  await writeFile(pdf, writingMaterialPdf());
  await writeFile(chart, Buffer.from(writingMaterialChart, "base64"));
  const instruction = "Describe the marked evidence.";
  const generated = "The selected chart region is blue.";
  type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
  const received: { path?: string; model: string; content: Part[] }[] = [];
  const endpoint = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { model, messages } = JSON.parse(body);
    received.push({ path: request.url, model, content: messages.at(-1).content });
    const content = received.length === 1 ? "green,yellow" : generated;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  });

  async function fillMaterial(label: string, value: string) {
    await clickPath(`//form//label[normalize-space(text()[1])='${label}']/input`);
    await keyActions([...chord(keys.control, "a"), ...typing(value)]);
  }

  async function acceptVisual(name: string) {
    await waitForView(
      `image pixels to be available for ${name}`,
      `const fieldset = [...document.querySelectorAll('form fieldset')]
        .find(group => group.querySelector(':scope > legend')?.textContent === ${JSON.stringify(name)});
        const option = fieldset?.querySelector('option[value=image]:enabled');
        if (!option) return false;
        option.parentElement.value = 'image';
        option.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
        return true;`,
    );
    await clickPath(
      `//form//fieldset[legend[normalize-space(.)='${name}']]//button[not(@disabled) and normalize-space(.)='Use selected material']`,
    );
  }

  async function sentPixel(url: string, x: number, y: number) {
    assert.match(url, /^data:image\/png;base64,/);
    const result = await command<number[] | null>("POST", `/session/${session}/execute/async`, {
      script: `const [url, x, y, done] = arguments;
        const image = new Image();
        image.onerror = () => done(null);
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const drawing = canvas.getContext('2d');
          drawing.drawImage(image, 0, 0);
          done([image.width, image.height, ...drawing.getImageData(x, y, 1, 1).data]);
        };
        image.src = url;`,
      args: [url, x, y],
    });
    assert.ok(result, "the transmitted PNG decodes");
    return result;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      endpoint.once("error", reject);
      endpoint.listen(0, "127.0.0.1", resolve);
    });
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    await restart([document]);
    await waitForActiveDocument(document);
    await nativeShortcut("ctrl+n");
    await click("Draft with AI");
    await chooseCustomDraftConnection();
    for (const [label, value] of [
      ["API address", `http://127.0.0.1:${address.port}/v1`],
      ["Model name", "native-vision-fixture"],
      ["Drafting instruction", instruction],
    ] as const) {
      await clickPath(`//form//label[normalize-space(.)='${label}']/input`);
      await keyActions(typing(value));
    }
    await clickPath("//form//summary[normalize-space(.)='Add files or paste text']");
    await chooseWebViewFile("Choose material file", pdf, "body");
    await chooseWebViewFile("Choose material file", chart, "body");
    await fillMaterial("PDF page", "2");
    await fillMaterial("Left (px)", "5");
    await fillMaterial("Top (px)", "1");
    await fillMaterial("Width (px)", "2");
    await fillMaterial("Height (px)", "2");
    assert.equal(received.length, 0, "selecting ranges performs no model requests");
    await click("Check image support");
    await waitForView(
      "the preview model's verified image support",
      "return document.querySelector('form')?.innerText.includes('Image support verified');",
    );
    assert.equal(received.length, 1);
    assert.doesNotMatch(JSON.stringify(received[0]), /field-notes|chart\.png|marked evidence/);
    await acceptVisual("field-notes.pdf");
    await acceptVisual("chart.png");
    await waitForView(
      "the exact page and crop in the native draft send list",
      `const list = document.querySelector('form')?.innerText;
        return list?.includes('field-notes.pdf · Page 2 of 2 · Image pixels') &&
          list.includes('chart.png · x 5, y 1 · 2 × 2 px · Image pixels');`,
    );
    await clickPath("//form//button[not(@disabled) and normalize-space(.)='Generate draft']");
    await waitForView(
      "the visual model response in the untitled editor",
      `return document.querySelector('[role=tabpanel]:not([hidden]) .cm-content')?.textContent === ${JSON.stringify(generated)};`,
    );
    assert.equal(received.length, 2);
    const request = received[1];
    assert.equal(request?.path, "/v1/chat/completions");
    assert.equal(request?.model, "native-vision-fixture");
    assert.equal(request?.content.length, 3);
    const [prompt, pageImage, cropImage] = request?.content ?? [];
    assert.ok(
      prompt?.type === "text" && pageImage?.type === "image_url" && cropImage?.type === "image_url",
    );
    assert.deepEqual(JSON.parse(prompt.text).taskContext.materials, [
      { name: "field-notes.pdf", range: { kind: "pdf", page: 2, pages: 2 }, format: "image" },
      {
        name: "chart.png",
        range: { kind: "image", x: 5, y: 1, width: 2, height: 2 },
        format: "image",
      },
    ]);
    assert.deepEqual(await sentPixel(pageImage.image_url.url, 4, 155), [640, 160, 0, 255, 0, 255]);
    assert.deepEqual(await sentPixel(cropImage.image_url.url, 0, 0), [2, 2, 0, 0, 255, 255]);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
});

const credentialPolicy = process.env.MINT_SMOKE_CREDENTIAL_POLICY;
test("native MCP calls modify only the explicitly authorized target", async () => {
  const target = join(dir, "mcp-trail.txt");
  const outside = join(dir, "mcp-private.txt");
  await writeFile(target, "Original public entry.");
  await writeFile(outside, "Private entry.");

  const changed = "Updated public entry.";
  const tool = {
    name: "update_entry",
    description: "Replace an entry in the fixture library.",
    inputSchema: { type: "object", properties: { entry: { type: "string" } } },
  };
  const calls: { name: string; arguments: { entry: string } }[] = [];
  const modelCalls: string[] = [];
  const outcomes: string[] = [];
  let protocolErrors = 0;
  const endpoint = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      if (request.url === "/v1/chat/completions") {
        const prompt: string = JSON.parse(body).messages.at(-1).content;
        const scenario = ["Deny", "Outside", "Approve"].find((name) => prompt.includes(name));
        if (scenario) modelCalls.push(scenario);
        const outcome = /MCP tool outcome \(source data\): (\{.*\})\. Continue/.exec(prompt)?.[1];
        if (outcome) outcomes.push(JSON.parse(outcome).status);
        const text = outcome
          ? `Ridge bulletin for ${scenario}.`
          : JSON.stringify({
              requestTool: {
                name: tool.name,
                arguments: { entry: scenario === "Outside" ? "private" : "trail" },
              },
            });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 39, completion_tokens: 6, total_tokens: 45 },
          }),
        );
        return;
      }
      assert.equal(request.url, "/mcp");
      assert.equal(request.headers.accept, "application/json, text/event-stream");
      assert.equal(request.headers.authorization, undefined);
      if (request.method === "DELETE") {
        response.writeHead(200).end();
        return;
      }
      const { id, method, params } = JSON.parse(body);
      assert.equal(request.method, "POST");
      if (method !== "initialize") {
        assert.equal(request.headers["mcp-protocol-version"], "2025-11-25");
        assert.equal(request.headers["mcp-session-id"], "mint-smoke");
      }
      if (method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (method === "initialize") {
        assert.equal(params.protocolVersion, "2025-11-25");
        response.setHeader("Mcp-Session-Id", "mint-smoke");
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "MINT smoke", version: "1" },
        };
      } else if (method === "tools/list") {
        result = { tools: [tool] };
      } else {
        assert.equal(method, "tools/call");
        calls.push(params);
        await writeFile(params.arguments.entry === "trail" ? target : outside, changed);
        result = { content: [{ type: "text", text: "Entry updated." }] };
      }
      const reply = JSON.stringify({ jsonrpc: "2.0", id, result });
      if (method === "tools/list") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`event: message\ndata: ${reply}\n\n`);
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(reply);
      }
    } catch {
      protocolErrors++;
      response.writeHead(400).end();
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      endpoint.once("error", reject);
      endpoint.listen(0, "127.0.0.1", resolve);
    });
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    await restart([document]);
    await waitForActiveDocument(document);
    for (const scenario of ["Deny", "Outside", "Approve"]) {
      await nativeShortcut("ctrl+n");
      await click("Draft with AI");
      await chooseCustomDraftConnection();
      for (const [label, value] of [
        ["API address", `${base}/v1`],
        ["Model name", "mcp-model-fixture"],
        ["Drafting instruction", `${scenario} the update and draft a bulletin.`],
      ] as const) {
        await clickPath(`//form//label[normalize-space(.)='${label}']/input`);
        await keyActions(typing(value));
      }
      await clickPath("//form//summary[normalize-space(.)='MCP tools']");
      await clickPath("//form//label[normalize-space(.)='MCP endpoint']/input");
      await keyActions(typing(`${base}/mcp`));
      await click("Find tools");
      for (const [label, value] of [
        ["MCP tool", tool.name],
        ["External effect", "modify"],
      ]) {
        await until(`${label} to offer ${value}`, () =>
          command<boolean>("POST", `/session/${session}/execute/sync`, {
            script: `const [label, value] = arguments;
              const select = [...document.querySelectorAll('form label')]
                .find(element => element.firstChild?.textContent === label)?.control;
              if (!select || ![...select.options].some(option => option.value === value)) return false;
              select.value = value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              return true;`,
            args: [label, value],
          }).then((ready) => ready || null),
        ).catch(explain);
      }
      if (scenario !== "Deny") {
        await clickPath(
          "//form//label[normalize-space(.)='Exact arguments to authorize']/textarea",
        );
        await keyActions(typing('{"entry":"trail"}'));
      }
      if (scenario === "Approve") {
        await waitForView(
          "the loopback model and MCP endpoint in the call plan",
          `const plan = [...document.querySelectorAll('form fieldset')].find(
            field => field.querySelector(':scope > legend')?.textContent === 'Task call plan'
          );
          return plan?.innerText.includes('${base}/v1/chat/completions') &&
            plan.innerText.includes('${base}/mcp') &&
            plan.innerText.includes('1 planned writing call');`,
        );
        await clickPath("//form//label[normalize-space(.)='Task call limit']/input");
        await keyActions(typing("1"));
      }
      await clickPath(
        "//form//button[starts-with(normalize-space(.),'Generate draft') and not(@disabled)]",
      );
      if (scenario === "Deny") {
        await waitForView(
          "the proposed MCP effect, endpoint and target",
          `const approval = [...document.querySelectorAll('fieldset')].find(
              field => field.querySelector(':scope > legend')?.textContent === 'External tool approval'
            );
            const text = approval?.innerText;
            return text?.includes('Modify an external target') && text.includes('${base}/mcp')
              && text.includes('"entry": "trail"');`,
        );
        assert.deepEqual(calls, []);
        await click("Deny tool call");
      }
      if (scenario === "Approve") {
        const paused = (count: number, recipient: string) =>
          waitForView(
            `call ${count + 1} to wait for the author before reaching ${recipient}`,
            `const pause = [...document.querySelectorAll('form fieldset')].find(
              field => field.querySelector(':scope > legend')?.textContent === 'Task paused at call limit'
            );
            return pause?.innerText.includes('Calls used: ${count}') &&
              pause.innerText.includes('Next recipient: ${recipient}') &&
              pause.innerText.includes('45 tokens reported across 1 writing call');`,
          );
        await paused(1, `${base}/mcp`);
        assert.deepEqual(calls, []);
        assert.equal(await readFile(target, "utf8"), "Original public entry.");
        assert.equal(modelCalls.filter((name) => name === "Approve").length, 1);
        await click("Allow one more call");
        await paused(2, `${base}/v1/chat/completions`);
        assert.deepEqual(calls, [{ name: tool.name, arguments: { entry: "trail" } }]);
        assert.equal(await readFile(target, "utf8"), changed);
        assert.equal(modelCalls.filter((name) => name === "Approve").length, 1);
        await click("Allow one more call");
      }
      await waitForView(
        `the completed ${scenario} draft`,
        `return [...document.querySelectorAll('.cm-content')].some(
           editor => editor.textContent === 'Ridge bulletin for ${scenario}.');`,
      );
      assert.equal(await readFile(outside, "utf8"), "Private entry.");
      assert.equal(
        await readFile(target, "utf8"),
        scenario === "Approve" ? changed : "Original public entry.",
      );
      assert.deepEqual(
        calls,
        scenario === "Approve" ? [{ name: tool.name, arguments: { entry: "trail" } }] : [],
      );
    }
    assert.deepEqual(outcomes, ["denied", "outside", "done"]);
    assert.deepEqual(modelCalls, ["Deny", "Deny", "Outside", "Outside", "Approve", "Approve"]);
    assert.equal(protocolErrors, 0);
  } finally {
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

test("model keys survive a restart only when remembered and disconnect removes the OS credential", {
  skip: !credentialPolicy && "requires the hosted smoke suite's isolated Secret Service",
}, async () => {
  assert.ok(credentialPolicy && process.env.XDG_DATA_HOME);
  const draft = join(dir, "model-connection-review.md");
  const excerpt = "Tuesday entry";
  const note = "Confirmed the date against the field log.";
  const manuscript = Buffer.from(`\uFEFF${excerpt}  \r\n\r\n# Field notes\r\n`);
  await writeFile(draft, manuscript);
  const persistentKey = "mint-smoke-remembered-7291";
  const sessionKey = "mint-smoke-session-8732";
  const requests: { method?: string; url?: string; authorization?: string; body: unknown }[] = [];
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(
        JSON.stringify({ choices: [{ message: { content: `Fixture reply ${requests.length}` } }] }),
      );
  });
  await new Promise<void>((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.listen(0, "127.0.0.1", resolve);
  });
  const address = endpoint.address();
  assert.ok(address && typeof address !== "string");
  const api = `http://127.0.0.1:${address.port}/v1`;
  const lookup = ["lookup", "service", "io.github.amemiya02.mint.model"];
  const lookupKey = () => exec("secret-tool", lookup, { timeout: 10_000 });
  const openConnections = async () => {
    await openSettings();
    await click("Model connections");
    await shows("Sample prompt");
  };
  const card = (name: string) => `//section[@aria-label='${name}']`;
  const clickCard = (name: string, action: string) =>
    clickPath(`${card(name)}//button[not(@disabled) and normalize-space(.)='${action}']`);
  async function fill(name: string, value: string) {
    const element = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "xpath",
      value: `//dialog[@open]//label[normalize-space(.)='${name}']/input`,
    });
    await command("POST", `/session/${session}/element/${element[elementKey]}/clear`, {});
    await command("POST", `/session/${session}/element/${element[elementKey]}/value`, {
      text: value,
    });
  }
  async function setStoreAvailable(available: boolean) {
    await writeFile(
      credentialPolicy as string,
      available
        ? "<busconfig/>"
        : '<busconfig><policy context="mandatory"><deny send_destination="org.freedesktop.secrets"/></policy></busconfig>',
    );
    await busCall("ReloadConfig");
  }
  const readDefaultCollection = () =>
    exec(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.secrets",
        "--object-path",
        "/org/freedesktop/secrets",
        "--method",
        "org.freedesktop.Secret.Service.ReadAlias",
        "default",
      ],
      { timeout: 5000 },
    );
  const versions = () => invokeNative<number[]>("list_versions", { path: draft });
  const versionText = (id: number) => invokeNative<string>("read_version", { path: draft, id });
  const annotations = () =>
    invokeNative<Record<string, { excerpt: string; note: string; resolved: boolean }>>(
      "read_annotations",
      { path: draft },
    );

  try {
    await restart([draft]);
    await clickPath(`//div[contains(@class, 'cm-content')][contains(., '${excerpt}')]`);
    await keyActions([...chord(keys.control, keys.home), ...chord(keys.shift, keys.end)]);
    await click("Add annotation");
    const field = await command<Record<string, string>>("POST", `/session/${session}/element`, {
      using: "css selector",
      value: "dialog[open] textarea",
    });
    await command("POST", `/session/${session}/element/${field[elementKey]}/value`, { text: note });
    await click("Save annotation");
    await click("Mark resolved");
    const review = await until("the resolved annotation to reach native app data", async () => {
      const entries = await annotations();
      return Object.values(entries).some(
        (item) => item.excerpt.trim() === excerpt && item.note === note && item.resolved,
      )
        ? entries
        : null;
    }).catch(explain);
    await invokeNative("record_version", {
      path: draft,
      text: "# Field notes\r\n\r\nMonday entry",
    });
    const history = await versions();
    const latestId = history.at(-1);
    assert.ok(latestId !== undefined, "verify an existing local version history survives");
    const latest = await versionText(latestId);
    await openConnections();
    await fill("API address", api);
    await fill("Model name", "smoke-model");
    await fill("Connection name", "Remembered model");
    await fill("API key", persistentKey);
    await clickPath("//button[not(@disabled) and normalize-space(.)='Remember connection']");
    await shows("••••7291");
    assert.equal((await lookupKey()).stdout.trim(), persistentKey);
    const metadata = await readFile(
      join(
        process.env.XDG_DATA_HOME,
        "io.github.amemiya02.mint",
        "model-connections",
        "connections.json",
      ),
      "utf8",
    );
    assert.ok(metadata.includes("Remembered model") && !metadata.includes(persistentKey));
    const visible = await command<string>("POST", `/session/${session}/execute/sync`, {
      script: "return document.querySelector('dialog[open]').innerText",
      args: [],
    });
    assert.ok(!visible.includes(persistentKey));

    await setStoreAvailable(false);
    await assert.rejects(readDefaultCollection(), /org\.freedesktop\.DBus\.Error\.AccessDenied/);
    await fill("Connection name", "Launch model");
    await fill("API key", sessionKey);
    await clickPath("//button[not(@disabled) and normalize-space(.)='Remember connection']");
    await shows("System credential store is unavailable");
    await clickPath("//button[not(@disabled) and normalize-space(.)='Use for this launch']");
    await shows("••••8732");
    await clickCard("Launch model", "Run sample");
    await shows("Fixture reply 1");
    await setStoreAvailable(true);
    assert.match(
      (await readDefaultCollection()).stdout,
      /objectpath '\/org\/freedesktop\/secrets\/collection\//,
    );

    await clickSettingsButton("Close");
    await restart([draft]);
    await openConnections();
    await shows("Remembered model");
    const launchCards = () =>
      command<unknown[]>("POST", `/session/${session}/elements`, {
        using: "xpath",
        value: card("Launch model"),
      });
    assert.deepEqual(await launchCards(), []);
    await clickCard("Remembered model", "Run sample");
    await shows("Fixture reply 2");
    for (const [index, key] of [sessionKey, persistentKey].entries()) {
      assert.deepEqual(requests[index], {
        method: "POST",
        url: "/v1/chat/completions",
        authorization: `Bearer ${key}`,
        body: {
          model: "smoke-model",
          stream: true,
          messages: [
            {
              role: "user",
              content: await command<string>("POST", `/session/${session}/execute/sync`, {
                script: "return document.querySelector('dialog[open] textarea[readonly]').value",
                args: [],
              }),
            },
          ],
        },
      });
    }
    await clickCard("Remembered model", "Disconnect");
    await until("the OS credential to be removed", async () => {
      try {
        await lookupKey();
        return null;
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 1);
        return true;
      }
    }).catch(explain);
    await clickSettingsButton("Close");
    await restart([draft]);
    await openConnections();
    assert.deepEqual(await invokeNative("list_model_connections", {}), []);
    assert.deepEqual(await readFile(draft), manuscript);
    assert.deepEqual(await versions(), history);
    assert.equal(await versionText(latestId), latest);
    assert.deepEqual(await annotations(), review);
    assert.equal(requests.length, 2, "reopening Settings never sends a model request");
    await clickSettingsButton("Close");
    await click("Annotations");
    await clickPath("//section[@aria-label='Resolved']//button[normalize-space(.)='Go to target']");
    const target = await command<string>("POST", `/session/${session}/execute/sync`, {
      script: "return getSelection()?.toString().trim()",
      args: [],
    });
    assert.equal(target, excerpt);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await setStoreAvailable(true);
  }
});

test("the daily journal creates one ordinary Markdown file only after permission is granted", async () => {
  const folder = await mkdtemp(join(dir, "journal-"));
  const draft = join(folder, "draft.md");
  await writeFile(draft, "Another manuscript.  \r\n");
  await restart([folder, draft]);
  const plugin = "//fieldset[@aria-label='Daily journal']";
  const chooseJournal = () => runPaletteCommand("Open today’s journal", "journal");
  await clickPath("//*[@role='treeitem' and @aria-label='draft.md']");
  await openSettings();
  await clickPath(`${plugin}//button[normalize-space(.)='Install']`);
  await shows("Create today’s Markdown journal in the current folder and open it");
  await clickPluginReview("Daily journal", "Deny access");
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
  await waitForActiveDocument(path);
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

test("external Agent consent gates a real CLI process and keeps the manuscript out of its input", async () => {
  const fixture = await mkdtemp(join(dir, "external-agent-"));
  const draft = join(fixture, "draft.md");
  const executable = join(fixture, "fixture-codex");
  const calls = join(fixture, "calls.jsonl");
  const cancelInstruction = "Generate a reply I can stop.";
  const temporaryInstruction = "Shorten this privately, apply directly";
  const privateMaterial = "A confidential interview excerpt for the temporary session.";
  const writeTarget = join(fixture, "agent-write.txt");
  const initial = "Unsent paragraph.\n\nOn-disk sentence.";
  const configuredAccessNotice = "Configured file access may include writes across your account.";
  const chooseAgentRecipient = () =>
    waitForView(
      "the approved Codex connection to be selected in Ask AI",
      `const option = [...document.querySelectorAll('section[aria-label="Ask AI"] select option')]
         .find(option => option.textContent === ${JSON.stringify(`Codex · ${executable}`)});
       if (!option || option.disabled) return false;
       option.parentElement.value = option.value;
       option.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`,
    );
  await writeFile(draft, initial);
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const readOnly = args.includes("--sandbox") && args[args.indexOf("--sandbox") + 1] === "read-only";
const prompt = JSON.parse(fs.readFileSync(0, "utf8"));
const readable = fs.readFileSync(${JSON.stringify(draft)}, "utf8");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  args, prompt, pid: process.pid, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), readable,
}) + "\\n");
if (prompt.instruction.startsWith("Is the selected line clear?")) fs.writeFileSync("review-copy.md", prompt.selectedText);
if (prompt.instruction.startsWith(${JSON.stringify(temporaryInstruction)})) {
  const copy = require("node:path").join(process.cwd(), "..", "retained-task-copy.md");
  fs.writeFileSync(copy, prompt.taskContext.materials[0].text);
}
if (!readOnly) fs.writeFileSync(${JSON.stringify(writeTarget)}, "configured access ran");
if (prompt.instruction === ${JSON.stringify(cancelInstruction)}) {
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Partial Agent reply." } }));
  setInterval(() => {}, 1000);
} else {
  const text = prompt.instruction.startsWith(${JSON.stringify(temporaryInstruction)})
    ? "<replacement>Short sentence.</replacement>"
    : prompt.annotationBatch
    ? JSON.stringify({ results: prompt.annotationBatch.map(({ id }) => ({ id, replacement: "Brief sentence." })) })
    : "Fixture Agent reply.";
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
}
`,
    { mode: 0o755 },
  );

  await restart([draft]);
  await openSettings();
  await click("External Agents");
  await clickPath("//label[normalize-space(.)='Codex executable']/input");
  await keyActions(typing(executable));
  await click("Inspect Agent");
  await shows("MINT launches this executable with your account’s file access.");
  await click("Try example");
  await click("Decline");
  await shows("Agent access declined.");
  await assert.rejects(readFile(calls), { code: "ENOENT" });

  const { path, revision } = await invokeNative<{ path: string; revision: string }>(
    "inspect_external_agent",
    { path: executable },
  );
  const request = { instruction: "Reply with one line.", selectedText: "One line." };
  await assert.rejects(
    invokeNative("send_external_agent", { path, revision, access: "readOnly", request }),
    /agentAccessRequired/,
  );
  await assert.rejects(readFile(calls), { code: "ENOENT" });

  await click("Try example");
  await click("Allow and send");
  await shows("Fixture Agent reply.");
  await shows("Conversation verified");
  const [sample] = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(sample.args.includes("--json"));
  assert.ok(sample.args.includes("--ephemeral"));
  assert.equal(sample.args.at(-1), "-");
  assert.equal(sample.args[sample.args.indexOf("--sandbox") + 1], "read-only");
  assert.deepEqual(sample.prompt, {
    instruction: "Suggest one concise rewrite of the selected text.",
    selectedText: "We are currently in the process of reviewing the draft.",
  });
  assert.notEqual(sample.cwd, fixture);
  assert.deepEqual(sample.entries, []);
  assert.equal(sample.readable, initial);
  await assert.rejects(readFile(writeTarget), { code: "ENOENT" });

  // Run the same installed connection from the manuscript, including a real follow-up process.
  await click("Close");
  await waitForView(
    "the manuscript to regain focus",
    "return document.activeElement?.matches('.cm-content');",
  );
  await keyActions([...chord(keys.control, keys.end), ...chord(keys.shift, keys.home)]);
  await click("Ask AI");
  await chooseAgentRecipient();
  await command("POST", `/session/${session}/execute/sync`, {
    script: `const action = document.querySelector('section[aria-label="Ask AI"] select');
      action.value = 'comment';
      action.dispatchEvent(new Event('change', { bubbles: true }));`,
    args: [],
  });
  const pdf = join(fixture, "field-notes.pdf");
  await writeFile(pdf, writingMaterialPdf());
  await clickPath(
    "//section[@aria-label='Ask AI']//summary[normalize-space(.)='Add files or paste text']",
  );
  await chooseWebViewFile("Choose material file", pdf, "body");
  await clickPath(
    "//section[@aria-label='Ask AI']//label[normalize-space(text()[1])='PDF page']/input",
  );
  await keyActions([...chord(keys.control, "a"), ...typing("2")]);
  await clickPath(
    "//section[@aria-label='Ask AI']//button[not(@disabled) and normalize-space(.)='Use selected material']",
  );
  await waitForView(
    "the selected PDF page and text format before the CLI send",
    `return document.querySelector('section[aria-label="Ask AI"]')?.innerText.includes('field-notes.pdf · Page 2 of 2 · Extracted text');`,
  );
  await clickPath("//section[@aria-label='Ask AI']//input[not(@type='checkbox')]");
  await keyActions([...typing("Is the selected line clear?"), ...typing(keys.enter)]);
  await waitForView(
    "the inline reply from the CLI",
    `return document.querySelector('section[aria-label="Ask AI"] textarea')?.value === 'Fixture Agent reply.' &&
      !document.querySelector('aside[aria-label="Writing Assistant"]');`,
  );
  await click("Continue in sidebar");
  await clickPath(
    "//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Remove field-notes.pdf']",
  );
  await command("POST", `/session/${session}/execute/sync`, {
    script: `const scope = [...document.querySelectorAll('aside[aria-label="Writing Assistant"] select')]
      .find((select) => select.querySelector('option[value="instruction"]'));
      scope.value = 'instruction';
      scope.dispatchEvent(new Event('change', { bubbles: true }));`,
    args: [],
  });
  const historyLabel = "Send earlier instructions and replies with this message";
  await clickPath(
    `//aside[@aria-label='Writing Assistant']//label[normalize-space(.)='${historyLabel}']/input[@type='checkbox']`,
  );
  await waitForView(
    "earlier instructions and replies to be approved for the follow-up",
    `return [...document.querySelectorAll('aside[aria-label="Writing Assistant"] label')]
      .find(label => label.textContent.trim() === ${JSON.stringify(historyLabel)})?.control.checked === true;`,
  );
  await clickPath("//aside[@aria-label='Writing Assistant']//input[not(@type='checkbox')]");
  await keyActions([...typing("What would help?"), ...typing(keys.enter)]);
  await waitForView(
    "both CLI replies in the sidebar",
    `return [...document.querySelectorAll('aside[aria-label="Writing Assistant"] textarea')]
      .filter((reply) => reply.value === 'Fixture Agent reply.').length === 2;`,
  );
  await click("Go to original selection");
  await waitForView(
    "the selected line to be restored",
    `return window.getSelection()?.toString() === "On-disk sentence.";`,
  );
  const selectedCalls = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line));
  assert.equal(selectedCalls.length, 2);
  const { instruction: selectedInstruction, ...selectedPayload } = selectedCalls[0].prompt;
  assert.match(selectedInstruction, /^Is the selected line clear\?/);
  assert.deepEqual(selectedPayload, {
    selectedText: "On-disk sentence.",
    taskContext: {
      materials: [
        {
          name: "field-notes.pdf",
          text: selectedPageText,
          range: { kind: "pdf", page: 2, pages: 2 },
          format: "extractedText",
        },
      ],
    },
  });
  assert.deepEqual(selectedCalls[1].prompt, {
    instruction: "What would help?",
    history: [{ instruction: "Is the selected line clear?", reply: "Fixture Agent reply." }],
  });
  assert.ok(selectedCalls.every((entry) => entry.entries.length === 0));
  const taskDir = dirname(selectedCalls[0].cwd);
  assert.ok(process.env.XDG_DATA_HOME);
  assert.equal(
    dirname(taskDir),
    join(process.env.XDG_DATA_HOME, "io.github.amemiya02.mint", "ai", "tasks"),
  );
  assert.equal(dirname(selectedCalls[1].cwd), taskDir);
  assert.match(await readFile(join(taskDir, "review.json"), "utf8"), /Is the selected line clear/);
  for (const { cwd } of selectedCalls) await assert.rejects(readdir(cwd), { code: "ENOENT" });
  // Exercise deletion with the kind of scratch directory left by an interrupted native run.
  const abandonedCopy = join(taskDir, ".agent-interrupted");
  await mkdir(abandonedCopy);
  await writeFile(join(abandonedCopy, "draft-copy.md"), initial);
  await symlink(draft, join(abandonedCopy, "manuscript-link.md"));
  assert.ok(
    selectedCalls.every((entry) => entry.args[entry.args.indexOf("--sandbox") + 1] === "read-only"),
  );
  assert.equal(await readFile(draft, "utf8"), initial);

  await command("POST", `/session/${session}/execute/sync`, {
    script: `const reply = document.querySelector('aside[aria-label="Writing Assistant"] textarea');
      reply.focus();
      reply.setSelectionRange("Fixture ".length, "Fixture Agent".length);`,
    args: [],
  });
  await clickPath(
    "//aside[@aria-label='Writing Assistant']//button[not(@disabled) and normalize-space(.)='Replace original selection in draft.md']",
  );
  await waitForView(
    "the selected part of the CLI reply in the editor",
    `return document.activeElement?.matches(".cm-content") &&
      document.activeElement.lastElementChild?.textContent === "Agent";`,
  );
  await nativeShortcut("ctrl+s");
  await until(
    "the selected reply excerpt on disk",
    async () =>
      (await readFile(draft, "utf8")) === initial.replace("On-disk sentence.", "Agent") || null,
  ).catch(explain);
  await keyActions(chord(keys.control, "z"));
  await nativeShortcut("ctrl+s");
  await until(
    "one undo to restore the manuscript bytes",
    async () => (await readFile(draft, "utf8")) === initial || null,
  ).catch(explain);

  await clickPath("//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Close']");
  await clickPath("//main//div[@role='textbox']");
  await keyActions([...chord(keys.control, keys.end), ...chord(keys.shift, keys.home)]);
  await clickPath("//footer//button[normalize-space(.)='Add annotation']");
  await clickPath("//dialog[@open][@aria-label='Add annotation']//textarea");
  await keyActions(typing("Shorten this sentence."));
  await click("Save annotation");
  await click("Send annotations for review");
  await waitForView(
    "the batch review action selector",
    "const option = document.querySelector('aside[aria-label=\"Annotations\"] option[value=\"direct\"]'); if (!option) return false; option.parentElement.value = option.value; option.parentElement.dispatchEvent(new Event('change', { bubbles: true })); return true;",
  );
  await clickPath(
    "//aside[@aria-label='Annotations']//button[@type='submit' and not(@disabled) and contains(.,'Apply directly') and contains(.,'Codex')]",
  );
  await waitForView(
    "the native Agent’s annotation edit to apply",
    "return document.querySelector('section[aria-label=\"Annotation review results\"]')?.innerText.includes('1 edit applied');",
  );
  const annotationRun = JSON.parse((await readFile(calls, "utf8")).trim().split("\n").at(-1) ?? "");
  assert.deepEqual(Object.keys(annotationRun.prompt).sort(), ["annotationBatch", "instruction"]);
  assert.equal(annotationRun.prompt.annotationBatch.length, 1);
  const [{ id, ...annotation }] = annotationRun.prompt.annotationBatch;
  assert.equal(typeof id, "string");
  assert.deepEqual(annotation, {
    kind: "text",
    excerpt: "On-disk sentence.",
    note: "Shorten this sentence.",
    editable: true,
  });
  assert.equal(annotationRun.args[annotationRun.args.indexOf("--sandbox") + 1], "read-only");
  assert.deepEqual(annotationRun.entries, []);
  assert.notEqual(dirname(annotationRun.cwd), taskDir);
  await assert.rejects(readdir(annotationRun.cwd), { code: "ENOENT" });
  assert.equal(annotationRun.readable, initial);
  await nativeShortcut("ctrl+s");
  await until(
    "the annotation edit to reach disk",
    async () =>
      (await readFile(draft, "utf8")) === initial.replace("On-disk sentence.", "Brief sentence.") ||
      null,
  ).catch(explain);
  await clickPath("//main//div[@role='textbox']");
  await keyActions(chord(keys.control, "z"));
  await nativeShortcut("ctrl+s");
  await until(
    "undo to restore the exact annotation review baseline",
    async () => (await readFile(draft, "utf8")) === initial || null,
  ).catch(explain);

  await openSettings();
  await clickSettingsButton("External Agents");

  await waitForView(
    "the saved Agent's permissions control in Settings",
    `const select = Array.from(document.querySelectorAll('dialog[open] select:enabled'))
      .find((control) => !control.closest('[hidden]') && control.querySelector('option[value="configured"]'));
      if (!select) return false;
      select.value = 'configured';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;`,
  );
  await shows(configuredAccessNotice);
  await clickSettingsButton("Try example");
  await shows("Change this Agent’s approved permissions?");
  await clickSettingsButton("Decline");
  await shows("Agent access declined.");
  await assert.rejects(
    invokeNative("send_external_agent", { path, revision, access: "configured", request }),
    /agentAccessRequired/,
  );
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 4);
  await assert.rejects(readFile(writeTarget), { code: "ENOENT" });

  await clickSettingsButton("Try example");
  await clickSettingsButton("Allow and send");
  await shows("Fixture Agent reply.");
  const callsBeforeRestart = (await readFile(calls, "utf8")).trim().split("\n").length;
  assert.equal(callsBeforeRestart, 5);
  assert.equal(await readFile(writeTarget, "utf8"), "configured access ran");
  assert.equal(await readFile(draft, "utf8"), initial);

  // Reopening the task after a native restart makes no CLI call. Deleting it clears its copies.
  await clickSettingsButton("Close");
  const history = await invokeNative<number[]>("list_versions", { path: draft });
  assert.ok(history.length);
  await restart([draft]);
  await click("Writing tasks");
  await click("Is the selected line clear?");
  await waitForView(
    "both saved CLI replies without another launch",
    `return [...document.querySelectorAll('aside[aria-label="Writing Assistant"] textarea')]
      .filter((reply) => reply.value === 'Fixture Agent reply.').length === 2;`,
  );
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, callsBeforeRestart);
  await clickPath(
    "//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Writing tasks']",
  );
  await clickPath("//button[@aria-label='Delete Is the selected line clear?']");
  await click("Delete task");
  await shows("No saved writing tasks for this document.");
  await assert.rejects(readdir(taskDir), { code: "ENOENT" });
  assert.equal(await readFile(draft, "utf8"), initial);
  assert.deepEqual(await invokeNative<number[]>("list_versions", { path: draft }), history);
  await clickPath("//dialog[@aria-label='Writing tasks']//button[normalize-space(.)='Close']");
  // The Agent connection and the granted scope are still available.
  await openSettings();
  await clickSettingsButton("External Agents");
  await shows(executable);
  await shows(configuredAccessNotice);
  await clickSettingsButton("Try example");
  await shows("Fixture Agent reply.");
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, callsBeforeRestart + 1);
  await clickSettingsButton("Close");
  await nativeShortcut("ctrl+n");
  await click("Draft with AI");
  await until("the approved Agent to appear as a draft recipient", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `const select = document.querySelector('[role="tabpanel"]:not([hidden]) form[aria-labelledby] select');
        const option = Array.from(select?.options ?? []).find(option => option.label === arguments[0]);
        if (!option) return false;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;`,
      args: [path],
    }).then((ready) => ready || null),
  ).catch(explain);
  await clickPath("//label[normalize-space(.)='Drafting instruction']/input");
  await keyActions(typing("Draft one paragraph about the ridge."));
  await addPastedWritingMaterial("A named detail for the Agent.");
  await clickPath("//button[not(@disabled) and normalize-space(.)='Generate draft']");
  await until("the completed Agent reply in the draft editor", () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `return document.querySelector('.cm-content:focus')?.textContent === 'Fixture Agent reply.'
        && document.querySelector('[role=tab][aria-selected=true]')?.textContent === 'Untitled';`,
      args: [],
    }).then((ready) => ready || null),
  ).catch(explain);
  const draftCall = JSON.parse((await readFile(calls, "utf8")).trim().split("\n").at(-1) ?? "");
  const { instruction: agentInstruction, ...agentContext } = draftCall.prompt;
  assert.match(
    agentInstruction,
    /^Write a Markdown draft[\s\S]+Draft one paragraph about the ridge\./,
  );
  assert.match(agentInstruction, /requestMaterial/);
  assert.deepEqual(agentContext, {
    taskContext: { materials: [{ name: "Pasted text", text: "A named detail for the Agent." }] },
  });
  assert.deepEqual(draftCall.entries, []);
  assert.ok(!draftCall.args.includes("--sandbox"));
  assert.equal(await readFile(draft, "utf8"), initial);

  const sourceTab = "//button[@role='tab' and normalize-space(.)='draft.md']";
  await clickPath(sourceTab);
  await keyActions([...chord(keys.control, keys.end), ...chord(keys.shift, keys.home)]);
  await click("Ask AI");
  await chooseAgentRecipient();
  await command("POST", `/session/${session}/execute/sync`, {
    script: `const action = document.querySelector('section[aria-label="Ask AI"] select');
      action.value = 'comment';
      action.dispatchEvent(new Event('change', { bubbles: true }));`,
    args: [],
  });
  await clickPath("//section[@aria-label='Ask AI']//label[normalize-space(.)='Instruction']/input");
  await keyActions([...typing(cancelInstruction), ...typing(keys.enter)]);
  await showsIn('section[aria-label="Ask AI"]', "Partial Agent reply.");
  const runningCall = JSON.parse((await readFile(calls, "utf8")).trim().split("\n").at(-1) ?? "");
  assert.equal(runningCall.prompt.instruction, cancelInstruction);
  const callsBeforeTemporary = (await readFile(calls, "utf8")).trim().split("\n").length;
  assert.equal(callsBeforeTemporary, callsBeforeRestart + 3);
  process.kill(runningCall.pid, 0);
  await clickPath("//section[@aria-label='Ask AI']//button[normalize-space(.)='Stop generation']");
  await until("the stopped CLI process to be reaped", async () => {
    try {
      process.kill(runningCall.pid, 0);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
  }).catch(explain);
  await waitForView(
    "the stopped CLI reply to remain in the conversation",
    `const composer = document.querySelector('section[aria-label="Ask AI"]');
      return composer?.innerText.includes('Stopped') &&
        composer.innerText.includes('Partial Agent reply.');`,
  );
  await assert.rejects(readdir(runningCall.cwd), { code: "ENOENT" });
  assert.equal(await readFile(draft, "utf8"), initial);

  const composer = "//section[@aria-label='Ask AI']";
  await clickPath(`${composer}//button[normalize-space(.)='Close']`);
  await keyActions([...chord(keys.control, keys.end), ...chord(keys.shift, keys.home)]);
  await click("Ask AI");
  await chooseAgentRecipient();
  await clickPath(`${composer}//label[normalize-space(.)='Temporary session']/input`);
  await addPastedWritingMaterial(privateMaterial);
  await clickPath(`${composer}//label[normalize-space(.)='Instruction']/input`);
  await keyActions([...typing(temporaryInstruction), ...typing(keys.enter)]);
  await clickPath(`${composer}//button[normalize-space(.)='View changes']`);
  const assistant = "//aside[@aria-label='Writing Assistant']";
  await waitForView(
    "the applied temporary edit to remain reviewable",
    `const edit = document.querySelector('aside[aria-label="Writing Assistant"] [aria-label="Proposed edit 1 of 1"]');
      return edit?.innerText.includes("Short sentence.") &&
        [...edit.querySelectorAll("button")].some((button) => button.textContent === "Revert this edit");`,
  );

  const temporaryCall = JSON.parse((await readFile(calls, "utf8")).trim().split("\n").at(-1) ?? "");
  assert.ok(temporaryCall.args.includes("--ephemeral"));
  assert.equal(temporaryCall.prompt.selectedText, "On-disk sentence.");
  assert.deepEqual(temporaryCall.prompt.taskContext.materials, [
    { name: "Pasted text", text: privateMaterial },
  ]);
  const temporaryDir = dirname(temporaryCall.cwd);
  assert.equal(
    dirname(temporaryDir),
    join(process.env.XDG_DATA_HOME, "io.github.amemiya02.mint", "ai", "temporary-tasks"),
  );
  assert.equal(
    await readFile(join(temporaryDir, "retained-task-copy.md"), "utf8"),
    privateMaterial,
  );
  assert.equal((await readdir(temporaryDir)).includes("review.json"), false);
  await nativeShortcut("ctrl+s");
  const retained = initial.replace("On-disk sentence.", "Short sentence.");
  await until(
    "the temporary revision to save",
    async () => (await readFile(draft, "utf8")) === retained || null,
  ).catch(explain);
  const versionIds = await until("the ordinary version of the temporary revision", async () => {
    const ids = await invokeNative<number[]>("list_versions", { path: draft });
    const latest = ids.at(-1);
    if (latest === undefined) return null;
    const text = await invokeNative<string>("read_version", { path: draft, id: latest });
    return text === retained ? ids : null;
  }).catch(explain);
  const taskRecordsBefore = await invokeNative<unknown[]>("list_writing_tasks", { path: draft });
  assert.equal(JSON.stringify(taskRecordsBefore).includes(temporaryInstruction), false);

  await clickPath(`${assistant}//button[normalize-space(.)='Close temporary session']`);
  await shows("You will lose the option to revert edits by task.");
  await clickPath("//dialog[@open]//button[normalize-space(.)='Close temporary session']");
  await until("the temporary task directory to be removed", async () => {
    try {
      await readdir(temporaryDir);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }).catch(explain);
  await waitForView(
    "the temporary review to close",
    `return !document.querySelector('aside[aria-label="Writing Assistant"], dialog[aria-label="Close temporary session"]');`,
  );
  assert.equal(await readFile(draft, "utf8"), retained);
  assert.deepEqual(await invokeNative<number[]>("list_versions", { path: draft }), versionIds);
  assert.equal(
    await invokeNative<string>("read_version", { path: draft, id: versionIds.at(-1) }),
    retained,
  );
  assert.deepEqual(
    await invokeNative<unknown[]>("list_writing_tasks", { path: draft }),
    taskRecordsBefore,
  );
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, callsBeforeTemporary + 1);
  await openSettings();
  await chooseSettingsOption("Multi-file connection", executable);
  await clickSettingsButton("Run sample", "Multi-file connection");
  await shows("Fixture Agent reply.");
  const callsBeforeReplacement = callsBeforeTemporary + 2;
  const callsAfterSample = (await readFile(calls, "utf8")).trim().split("\n");
  assert.equal(callsAfterSample.length, callsBeforeReplacement);
  const routedSample = JSON.parse(callsAfterSample.at(-1) ?? "");
  assert.deepEqual(routedSample.prompt, sample.prompt);
  assert.equal(routedSample.args.includes("--sandbox"), false);
  assert.equal(routedSample.args.at(-1), "-");
  await chooseSettingsOption("Multi-file connection", "Use the default writing connection");

  await clickSettingsButton("External Agents");
  // Load the saved revision before replacing the executable so the send rechecks it.
  await shows(configuredAccessNotice);
  await writeFile(
    executable,
    `${await readFile(executable, "utf8")}
// replacement
`,
  );
  await clickSettingsButton("Try example");
  await shows("Agent access changed. Review its permissions before sending.");
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, callsBeforeReplacement);
  await clickSettingsButton("Try example");
  await shows("Use Codex’s configured permissions and send the task shown above.");
  await clickSettingsButton("Decline");
  await shows("Agent access declined.");
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, callsBeforeReplacement);
  await clickSettingsButton("Forget Agent");
  await clickSettingsButton("Close");
});

test("Codex provides manuscript and folder reviews from approved task copies", async (t) => {
  const codex = process.env.MINT_SMOKE_CODEX;
  assert.ok(codex, "the hosted smoke job provisions the Codex CLI sandbox");
  const fixture = await mkdtemp(join(dir, "agent-task-copy-"));
  const draft = join(fixture, "manuscript.md");
  const sibling = join(fixture, "unapproved.md");
  const index = join(fixture, "index.md");
  const old = join(fixture, "old.md");
  const executable = join(fixture, "fixture-codex");
  const batchReceived = join(dir, "folder-batch-received.json");
  const batchRelease = join(dir, "folder-batch-release");
  const appendix = join(fixture, "batch-appendix.md");
  const sandboxFailure = join(dir, "task-copy-sandbox-error.log");
  t.after(async () => {
    try {
      t.diagnostic(await readFile(sandboxFailure, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  const initial = "First paragraph.  \r\n\r\nOriginal.\r\n";
  const unsaved = initial.replace("Original.", "Original. Unsaved note.");
  const changed = unsaved.replace("Original.", "Revised.");
  const batchBaseline = changed.replace("Unsaved note.", "Unsaved note. New note.");
  const batchDraft = batchBaseline.replace("Revised.", "Batch revision.");
  const approved = "Only the approved passage.";
  const preference = {
    topic: "Interview quotations",
    guidance: "Keep the interviewee's words verbatim.",
  };
  const skillInstruction = [
    "Correct spelling, punctuation, and grammar.",
    "Check capitalization and terminology for consistency.",
    "Preserve the author's meaning, voice, and Markdown structure.",
    "Follow the author's task instructions where they refine these steps.",
    "Revise the original sentence.",
    "Revise the text. Keep the rest of the passage intact.",
  ].join("\n");
  await writeFile(draft, initial);
  await writeFile(sibling, "Private text.");
  await writeFile(index, "[Old](old.md#section)\n");
  await writeFile(old, "## Section\n");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const codex = ${JSON.stringify(codex)};
const args = process.argv.slice(2);
function sandbox(args) {
  // MINT grants read access to the selected launcher. The fixture delegates to
  // a separate native binary that bubblewrap must be able to re-enter.
  const profile = args.findIndex(arg => arg.startsWith("permissions.mint-task-copy.filesystem={"));
  if (profile === -1 || !args[profile].endsWith("}")) throw new Error("Missing task copy profile");
  args[profile] = args[profile].slice(0, -1) + "," + JSON.stringify(codex) + '="read"}';
  const result = spawnSync(codex, ["sandbox", ...args], {
    stdio: ["ignore", "inherit", "pipe"],
  });
  if (result.status !== 0) {
    fs.appendFileSync(${JSON.stringify(sandboxFailure)},
      "Codex sandbox exit " + result.status + ": " + (result.error ?? result.stderr) + "\\n");
    process.exit(result.status ?? 1);
  }
}
if (args[0] === "sandbox") {
  sandbox(args.slice(1));
  process.exit(0);
}
const prompt = JSON.parse(fs.readFileSync(0, "utf8"));
const config = args.flatMap((arg, i) =>
  arg === "-c" && args[i + 1].startsWith("permissions.") ? ["-c", args[i + 1]] : []);
const sample = prompt.instruction.startsWith("Suggest one concise rewrite");
const folder = prompt.folderDocuments !== undefined;
const batch = prompt.folderWriteTargets !== undefined;
if (folder) {
  require("node:assert/strict").deepEqual(prompt.preferences, [${JSON.stringify(preference)}]);
  require("node:assert/strict").match(prompt.instruction, /explicit current instruction takes precedence/);
}
if (!sample && !folder && (!prompt.instruction.startsWith(${JSON.stringify(`${skillInstruction}\n\n`)}) ||
  !prompt.instruction.includes("Write the resulting Markdown to draft.md."))) process.exit(12);
if (folder && !batch && JSON.stringify(prompt.folderDocuments) !== JSON.stringify([
  "documents/index.md", "documents/manuscript.md", "documents/old.md",
])) process.exit(11);
if (batch) {
  fs.appendFileSync(${JSON.stringify(batchReceived)}, JSON.stringify(prompt) + "\\n");
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(${JSON.stringify(batchRelease)})) {
    if (Date.now() > deadline) process.exit(12);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
const shell = batch ? ${JSON.stringify(`set -eu
printf '%s' "$6" > expected.txt
cmp documents/manuscript.md expected.txt
rm expected.txt
printf '%s' "$8" > documents/manuscript.md
printf '%s\\n' '# Agent appendix' > documents/batch-appendix.md
printf '%s\\n' '# New document' > documents/batch-new.md
printf '%s\\n' '# Blocked creation' > documents/batch-occupied.md
printf '%s\\n' 'Unapproved write' > documents/batch-unlisted.md
printf '%s\\n' '[Blocked](batch-occupied.md)' > documents/index.md
mkdir documents/next
mv documents/batch-old.md documents/next/moved.md
printf '%s' '[{"from":"batch-old.md","to":"next/moved.md"}]' > moves.json
`)} : folder ? ${JSON.stringify(`set -eu
test "$(ls -a)" = "$(printf '.\n..\ndocuments')"
test "$(ls documents)" = "$(printf 'index.md\nmanuscript.md\nold.md')"
printf '%s' "$6" > expected.txt
cmp documents/manuscript.md expected.txt
rm expected.txt
if cat "$1" >/dev/null 2>&1 || cat "$2" >/dev/null 2>&1; then exit 9; fi
if (printf 'outside write' > "$1") 2>/dev/null || (printf 'outside write' > "$2") 2>/dev/null; then exit 10; fi
mkdir documents/chapter
mv documents/old.md documents/chapter/renamed.md
printf '%s' '[{"from":"old.md","to":"chapter/renamed.md"}]' > moves.json
printf '%s\n' '# Notes' > documents/notes.md
printf '%s\n' '[Old](chapter/renamed.md#section) · [Notes](notes.md)' > documents/index.md
printf '%s' "$7" > documents/manuscript.md
`)} : sample ? ${JSON.stringify(`set -eu
test "$(cat draft.md)" = "We are currently in the process of reviewing the draft."
printf '%s' "We are reviewing the draft." > draft.md
`)} : ${JSON.stringify(`set -eu
test "$(ls -a)" = "$(printf '.\n..\ndraft.md\nmaterials')"
test "$(ls materials)" = "1.txt"
test "$(cat materials/1.txt)" = "$3"
if cat "$1" >/dev/null 2>&1 || cat "$2" >/dev/null 2>&1; then exit 9; fi
if (printf 'outside write' > "$1") 2>/dev/null || (printf 'outside write' > "$2") 2>/dev/null; then exit 10; fi
printf '%s' "$4" > expected.txt
cmp draft.md expected.txt
rm expected.txt
printf '%s' "$5" > draft.md
printf 'unapproved new file' > unapproved-new.md
`)};
sandbox([
  ...config, "--permission-profile", "mint-task-copy",
  "--cd", process.cwd(), "--", "/bin/sh", "-c", shell, "fixture",
  ${JSON.stringify(draft)}, ${JSON.stringify(sibling)}, ${JSON.stringify(approved)},
  ${JSON.stringify(unsaved)}, ${JSON.stringify(changed)},
  ${JSON.stringify(changed.replace("Unsaved note.", "Unsaved note. New note."))},
  ${JSON.stringify(changed.replace("Revised.", "Folder revision.").replace("Unsaved note.", "Unsaved note. New note."))},
  ${JSON.stringify(batchDraft)},
]);
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Edited task copy." } }));
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    { mode: 0o700 },
  );

  await restart([fixture, draft]);
  await waitForActiveDocument(draft);
  await openSettings();
  const autosave = await command<boolean>("POST", `/session/${session}/execute/sync`, {
    script: `return Boolean([...document.querySelectorAll('dialog[open] label')]
      .find(label => label.textContent.trim() === 'Save automatically')?.control.checked);`,
    args: [],
  });
  if (autosave) {
    await clickPath(
      "//input[@type='checkbox' and @id=//label[normalize-space(.)='Save automatically']/@for]",
    );
  }
  await clickSettingsButton("External Agents");
  await clickPath("//label[normalize-space(.)='Codex executable']/input");
  await keyActions(typing(executable));
  await clickSettingsButton("Inspect Agent");
  const select = (label: string, value: string) =>
    command("POST", `/session/${session}/execute/sync`, {
      script: `const select = [...document.querySelectorAll('label')].find(
        label => label.firstChild?.textContent?.trim() === arguments[0])?.querySelector('select');
        const option = [...(select?.options ?? [])].find(option => !option.disabled &&
          (option.value === arguments[1] || option.textContent === arguments[1]));
        if (!option)
          throw new Error("Missing option " + arguments[1]);
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));`,
      args: [label, value],
    });
  await shows("MINT launches this executable with your account’s file access.");
  await select("Agent permissions", "taskCopy");
  await clickSettingsButton("Try example");
  await clickSettingsButton("Allow and send");
  await shows("Task copy editing verified");
  await clickSettingsButton("Close");

  await clickPath("//button[@role='tab' and normalize-space(.)='manuscript.md']");
  await clickPath("//div[contains(@class,'cm-line') and normalize-space(.)='Original.']");
  await keyActions([...typing(keys.end), ...typing(" Unsaved note.")]);
  await waitForView(
    "the unsaved note in the editor",
    `return document.querySelector('.cm-content')?.textContent.includes("Original. Unsaved note.");`,
  );
  async function send(action: "preview" | "direct") {
    await runPaletteCommand("Ask AI");
    await waitForView(
      "the task copy recipient to load",
      `return [...document.querySelectorAll('section[aria-label="Ask AI"] select option')]
        .some(option => option.textContent.includes(${JSON.stringify(executable)}));`,
    );
    await select("Recipient", `Codex · ${executable}`);
    await select("Scope", "document");
    await select("Action", action);
    await addPastedWritingMaterial(approved);
    await clickPath(
      "//section[@aria-label='Ask AI']//label[normalize-space(.)='Instruction']/input",
    );
    await keyActions(typing("/copyedit Revise the original sentence."));
    await clickPath("//section[@aria-label='Ask AI']//button[@type='submit' and not(@disabled)]");
  }

  await send("preview");
  await waitForView(
    "the proposed edit and discarded extra file to be shown",
    `const composer = document.querySelector('section[aria-label="Ask AI"]');
     return composer?.innerText.includes("Apply proposed edit") &&
       composer.innerText.includes("Other changes in the task copy were discarded.");`,
  );
  assert.equal(await readFile(draft, "utf8"), initial);
  assert.equal(await readFile(sibling, "utf8"), "Private text.");
  const modelRequests: { model: string; messages: { role: string; content: string }[] }[] = [];
  const modelDraft = unsaved.replace("First paragraph.", "Model opening.");
  const endpoint = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    modelRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        choices: [
          {
            message: { content: `<replacement>${modelDraft}</replacement>` },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.listen(0, "127.0.0.1", resolve);
  });
  let modelId: string | undefined;
  try {
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const modelAddress = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const modelLabel = `Comparison fixture · ${modelAddress}`;
    modelId = (
      await invokeNative<{ id: string }>("save_model_connection", {
        connection: {
          name: "Comparison fixture",
          address: modelAddress,
          model: "task-copy-comparison",
          apiKey: "",
          lifetime: "persistent",
        },
      })
    ).id;
    await openSettings();
    await clickSettingsButton("Close");
    await clickPath("//button[not(@disabled) and normalize-space(.)='Retry same baseline']");
    await waitForView(
      "the comparison model to appear in the retry recipient selector",
      `return [...document.querySelectorAll('aside fieldset select option')]
        .some(option => option.textContent === ${JSON.stringify(modelLabel)});`,
    );
    await select("Retry connection", modelLabel);
    await waitForView(
      "the saved task-copy material and model recipient before approval",
      `const approval = [...document.querySelectorAll('aside fieldset')].find(
        fieldset => fieldset.querySelector('legend')?.textContent === 'Retry same baseline');
       return approval?.innerText.includes('Pasted text') &&
         approval.innerText.includes(${JSON.stringify(modelLabel)});`,
    );
    assert.equal(modelRequests.length, 0);
    await click(`Send same baseline to ${modelLabel}`);

    const comparison = "//dialog[@open and @aria-label='Compare writing alternatives']";
    await waitForView(
      "two proposals from the native Agent and model",
      `const dialog = document.querySelector('dialog[open][aria-label="Compare writing alternatives"]');
       return dialog?.querySelector('[aria-label="Original proposal"]')?.innerText.includes('Revised. Unsaved note.') &&
         dialog?.querySelector('[aria-label="Alternative proposal"]')?.innerText.includes('Model opening.');`,
    );
    assert.equal(modelRequests.length, 1);
    assert.equal(modelRequests[0]?.model, "task-copy-comparison");
    assert.deepEqual(JSON.parse(modelRequests[0]?.messages.at(-1)?.content ?? ""), {
      instruction: skillInstruction,
      selectedText: unsaved,
      taskContext: { materials: [{ name: "Pasted text", text: approved }] },
    });
    assert.equal(await readFile(draft, "utf8"), initial);
    for (const proposal of ["Original proposal", "Alternative proposal"]) {
      const section = `section[aria-label="${proposal}"]`;
      await clickPath(
        `${comparison}//section[@aria-label='${proposal}']//button[normalize-space(.)='Apply proposed edit']`,
      );
      await waitForView(
        `the edit from the ${proposal.toLowerCase()} to apply`,
        `const proposal = document.querySelector('dialog[open][aria-label="Compare writing alternatives"]')
          ?.querySelector(${JSON.stringify(section)});
         return [...(proposal?.querySelectorAll('button') ?? [])]
          .some(button => button.textContent === 'Revert this edit');`,
      );
    }
    await clickPath(`${comparison}//button[normalize-space(.)='Close']`);
    await waitForView(
      "the manuscript to contain one change from each receiver",
      `const manuscript = document.querySelector('.cm-content')?.textContent;
       return manuscript?.includes('Model opening.') && manuscript.includes('Revised. Unsaved note.');`,
    );
    assert.equal(await readFile(draft, "utf8"), initial);
    await clickPath("//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Close']");
    await keyActions([...chord(keys.control, "z"), ...chord(keys.control, "z")]);
    await waitForView(
      "undo to keep the author's unsaved manuscript",
      `const manuscript = document.querySelector('.cm-content')?.textContent;
       return manuscript?.includes('First paragraph.') && manuscript.includes('Original. Unsaved note.');`,
    );
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    if (modelId) await invokeNative("disconnect_model_connection", { id: modelId });
  }
  await send("direct");
  await waitForView(
    "the manuscript change in the editor",
    `return document.querySelector('.cm-content')?.textContent.includes("Revised. Unsaved note.");`,
  );
  assert.equal(await readFile(draft, "utf8"), initial);
  await nativeShortcut("ctrl+s");
  await until("only the approved change to be saved", async () =>
    (await readFile(draft, "utf8")) === changed ? true : null,
  );
  assert.deepEqual((await readdir(fixture)).sort(), [
    "fixture-codex",
    "index.md",
    "manuscript.md",
    "old.md",
    "unapproved.md",
  ]);
  assert.equal(await readFile(sibling, "utf8"), "Private text.");

  await clickPath(
    "//div[contains(@class,'cm-line') and normalize-space(.)='Revised. Unsaved note.']",
  );
  await keyActions([...typing(keys.end), ...typing(" New note.")]);
  await runPaletteCommand("Ask AI about working folder");
  const assistant = "//aside[@aria-label='Writing Assistant']";
  await waitForView(
    "the working-folder Codex recipient to load",
    `return [...document.querySelectorAll('aside[aria-label="Writing Assistant"] option')]
      .some(option => option.textContent === ${JSON.stringify(`Codex · ${executable}`)});`,
  );
  await select("Recipient", `Codex · ${executable}`);
  await waitForView(
    "the folder task-copy document checklist",
    `return [...document.querySelectorAll('aside[aria-label="Writing Assistant"] label')]
      .some(label => label.textContent.trim() === "manuscript.md");`,
  );
  for (const path of ["manuscript.md", "index.md", "old.md"]) {
    await clickPath(`${assistant}//label[normalize-space(.)='${path}']/input[@type='checkbox']`);
  }
  const preferenceBox = `${assistant}//fieldset[legend[normalize-space(.)='Writing preferences to send']]`;
  await clickPath(`${preferenceBox}//summary[normalize-space(.)='Remember a correction']`);
  await select("Remember for", "folder");
  await clickPath(`${preferenceBox}//label[normalize-space(.)='Topic']/input`);
  await keyActions(typing(preference.topic));
  await clickPath(`${preferenceBox}//label[normalize-space(.)='Writing guidance']/textarea`);
  await keyActions(typing(preference.guidance));
  await clickPath(`${preferenceBox}//button[normalize-space(.)='Save writing preference']`);
  await showsIn('aside[aria-label="Writing Assistant"]', preference.guidance);
  await clickPath(`${assistant}//label[normalize-space(.)='Instruction']/input`);
  await keyActions([...typing("Organize these documents."), ...typing(keys.enter)]);
  await showsIn('aside[aria-label="Writing Assistant"]', "Requires chapter/renamed.md, notes.md");
  await showsIn(
    'aside[aria-label="Writing Assistant"]',
    "Folder revision. Unsaved note. New note.",
  );
  assert.equal(await readFile(draft, "utf8"), changed);
  assert.equal(await readFile(index, "utf8"), "[Old](old.md#section)\n");
  assert.equal(await readFile(old, "utf8"), "## Section\n");
  assert.deepEqual((await readdir(fixture)).sort(), [
    "fixture-codex",
    "index.md",
    "manuscript.md",
    "old.md",
    "unapproved.md",
  ]);
  const apply = (label: string) =>
    `${assistant}//fieldset[@aria-label='${label}']//button[normalize-space(.)='Apply proposed edit']`;
  await clickPath(apply("Create notes.md"));
  await until(
    "the new notes to be written",
    async () => (await readFile(join(fixture, "notes.md"), "utf8")) === "# Notes\n" || null,
  );
  assert.equal(await readFile(index, "utf8"), "[Old](old.md#section)\n");
  await clickPath(apply("Move and rename old.md → chapter/renamed.md"));
  const newPath = join(fixture, "chapter", "renamed.md");
  await until(
    "the chapter to be moved",
    async () => (await readFile(newPath, "utf8")) === "## Section\n" || null,
  );
  await assert.rejects(readFile(old), { code: "ENOENT" });
  await waitForView(
    "the backlink to become available after its dependencies",
    `return [...document.querySelectorAll('fieldset[aria-label="Modify index.md"] button')]
      .some(button => button.textContent.trim() === "Apply proposed edit" && !button.disabled);`,
  );
  await clickPath(apply("Modify index.md"));
  await until(
    "the backlink to be written",
    async () =>
      (await readFile(index, "utf8")) ===
        "[Old](chapter/renamed.md#section) · [Notes](notes.md)\n" || null,
  );
  assert.equal(await readFile(draft, "utf8"), changed);
  assert.equal(await readFile(sibling, "utf8"), "Private text.");
  await writeFile(appendix, "# Appendix\n");
  const batchOld = join(fixture, "batch-old.md");
  await writeFile(batchOld, "## Section\n");
  const batchIndex = "[Old](chapter/renamed.md#section) · [Notes](notes.md)\n";
  const newDocument = join(fixture, "batch-new.md");
  const occupied = join(fixture, "batch-occupied.md");
  const unlisted = join(fixture, "batch-unlisted.md");
  const moved = join(fixture, "next", "moved.md");
  const instruction = "Write the authorized folder batch.";
  const writeTargets = [
    "manuscript.md",
    "index.md",
    "batch-appendix.md",
    "batch-new.md",
    "batch-occupied.md",
    "batch-old.md",
    "next/moved.md",
  ];
  await clickPath(`${assistant}//button[normalize-space(.)='Close']`);
  await runPaletteCommand("Ask AI about working folder");
  await waitForView(
    "the folder Agent to load for the authorized batch",
    `return [...document.querySelectorAll('aside[aria-label="Writing Assistant"] option')]
      .some(option => option.textContent === ${JSON.stringify(`Codex · ${executable}`)});`,
  );
  await select("Recipient", `Codex · ${executable}`);
  await select("Action", "direct");
  for (const path of ["manuscript.md", "index.md", "batch-appendix.md", "batch-old.md"]) {
    await clickPath(`${assistant}//label[normalize-space(.)='${path}']/input[@type='checkbox']`);
  }
  await clickPath(
    `${assistant}//label[normalize-space(.)='Write targets (one relative Markdown path per line)']/textarea`,
  );
  for (const [i, path] of writeTargets.entries()) {
    if (i > 0) await keyActions(typing(keys.enter));
    await keyActions(typing(path));
  }
  await waitForView(
    "all disk write targets to be displayed before sending",
    `return JSON.stringify([...document.querySelectorAll('ul[aria-label="Files authorized for writing"] li')]
      .map(item => item.textContent)) === ${JSON.stringify(JSON.stringify(writeTargets))};`,
  );
  await assert.rejects(readFile(batchReceived), { code: "ENOENT" });
  await clickPath(`${assistant}//label[normalize-space(.)='Instruction']/input`);
  await keyActions([...typing(instruction), ...typing(keys.enter)]);
  try {
    const request = await until("the native Agent to receive its write targets", async () =>
      JSON.parse(await readFile(batchReceived, "utf8")),
    );
    assert.deepEqual(request.folderWriteTargets, writeTargets);
    assert.deepEqual(request.folderDocuments, [
      "documents/batch-appendix.md",
      "documents/batch-old.md",
      "documents/index.md",
      "documents/manuscript.md",
    ]);
    assert.ok(!JSON.stringify(request).includes(fixture));
    await writeFile(occupied, "Author's concurrent creation.\n");
    await writeFile(appendix, "Author's concurrent appendix edit.\n");
  } finally {
    await writeFile(batchRelease, "");
  }
  const batchReview = 'section[aria-label="Folder changes"]';
  await showsIn(batchReview, "Written to disk.");
  await showsIn(batchReview, "Could not apply this file change");
  await showsIn(batchReview, "The document changed since this task began.");
  await showsIn(batchReview, "Waiting for required file changes.");
  await showsIn(batchReview, "Outside the task scope · batch-unlisted.md");
  assert.equal(await readFile(draft, "utf8"), batchDraft);
  assert.equal(await readFile(newDocument, "utf8"), "# New document\n");
  assert.equal(await readFile(moved, "utf8"), "## Section\n");
  await assert.rejects(readFile(batchOld), { code: "ENOENT" });
  assert.equal(await readFile(index, "utf8"), batchIndex);
  assert.equal(await readFile(occupied, "utf8"), "Author's concurrent creation.\n");
  assert.equal(await readFile(appendix, "utf8"), "Author's concurrent appendix edit.\n");
  await assert.rejects(readFile(unlisted), { code: "ENOENT" });
  const laterNote = "\r\nIndependent later author note.\r\n";
  await writeFile(draft, batchDraft + laterNote);
  await rm(occupied);
  await clickPath(`${assistant}//button[normalize-space(.)='Retry unfinished file changes']`);
  await until(
    "the deferred native backlink to be written on retry",
    async () => (await readFile(index, "utf8")) === "[Blocked](batch-occupied.md)\n" || null,
  );
  assert.equal(await readFile(draft, "utf8"), batchDraft + laterNote);
  assert.equal((await readFile(batchReceived, "utf8")).trim().split("\n").length, 1);
  await clickPath(`${assistant}//button[normalize-space(.)='Close']`);
  await restart([fixture, draft]);
  await runPaletteCommand("All writing tasks");
  await clickPath(
    `//dialog[@aria-label='All writing tasks']//button[normalize-space(.)='${instruction}']`,
  );
  await waitForView(
    "the working-folder preference to be available to send after restarting",
    `const panel = [...document.querySelectorAll('aside[aria-label="Writing Assistant"] fieldset')]
      .find(group => group.querySelector(':scope > legend')?.textContent === 'Writing preferences to send');
      return [...(panel?.querySelectorAll('li') ?? [])].some(row =>
        row.textContent.includes("Working folder") &&
        row.textContent.includes(${JSON.stringify(preference.topic)}) &&
        row.textContent.includes(${JSON.stringify(preference.guidance)}));`,
  );
  await clickPath(
    `${assistant}//fieldset[@aria-label='Create batch-new.md']//button[normalize-space(.)='Revert this file change']`,
  );
  await showsIn('fieldset[aria-label="Create batch-new.md"]', "Edit reverted.");
  await assert.rejects(readFile(newDocument), { code: "ENOENT" });
  await clickPath(`${assistant}//button[normalize-space(.)='Revert all task edits']`);
  await showsIn(
    'fieldset[aria-label="Move and rename batch-old.md → next/moved.md"]',
    "Edit reverted.",
  );
  assert.equal(await readFile(draft, "utf8"), batchBaseline + laterNote);
  assert.equal(await readFile(index, "utf8"), batchIndex);
  assert.equal(await readFile(batchOld, "utf8"), "## Section\n");
  for (const file of [moved, newDocument, occupied, unlisted]) {
    await assert.rejects(readFile(file), { code: "ENOENT" });
  }
  assert.equal(await readFile(appendix, "utf8"), "Author's concurrent appendix edit.\n");
  assert.equal(await readFile(sibling, "utf8"), "Private text.");
  assert.equal((await readFile(batchReceived, "utf8")).trim().split("\n").length, 1);
  await invokeNative("forget_external_agent", { path: executable });
});
