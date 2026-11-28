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

async function openSettings() {
  // Wait for the real GTK menu item, which is installed after the webview starts.
  await exec(
    "/usr/bin/python3",
    ["smoke/activate-gtk-menu.py", await instancePid(), "MINT", "Settings…"],
    {
      timeout: 35_000,
    },
  ).catch(explain);
  await waitForView(
    "the native Settings menu command to open Settings",
    "return document.querySelector('dialog[open] h2')?.textContent === 'Settings'",
  );
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
const clickSettingsButton = (label: string) =>
  clickPath(
    `//dialog[@open][.//h2[normalize-space(.)='Settings']]//button[normalize-space(.)='${label}' and not(@disabled) and not(ancestor::fieldset[@disabled])]`,
  );
const shows = (text: string) =>
  until(text, () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script:
        "return document.querySelector('dialog[open]')?.innerText.includes(arguments[0]) === true",
      args: [text],
    }).then((found) => (found ? true : null)),
  ).catch(explain);

const chooseSettingsOption = (setting: string, label: string) =>
  until(`${setting} to offer ${label}`, () =>
    command<boolean>("POST", `/session/${session}/execute/sync`, {
      script: `const select = [...document.querySelectorAll('dialog[open] label')]
        .find(label => label.textContent.trim() === arguments[0])?.control;
        const option = select && [...select.options].find(item => item.text === arguments[1]);
        if (!option) return false;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;`,
      args: [setting, label],
    }).then((chosen) => chosen || null),
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
  let pendingPreview: ServerResponse | undefined;
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
    if (!payload.stream) {
      if (payload.messages.at(-1)?.content.includes(previewInstruction)) {
        pendingPreview = response;
        return;
      }
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
    assert.equal(payload.stream, false);
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
    await waitForView(
      "the remaining view to regain focus",
      "return document.querySelectorAll('.cm-content').length === 1 && document.activeElement?.matches('.cm-content');",
    );
    await keyActions([...chord(keys.control, keys.end), ...chord(keys.shift, keys.home)]);
    await askSelection(instruction, authorization);
    await until(
      "the direct edit to autosave the exact native file",
      async () => (await readFile(draft)).equals(Buffer.from(edited)) || null,
    ).catch(explain);
    assert.deepEqual(requests[2], sent);
    await clickPath(
      "//section[@aria-label='Ask AI']//button[normalize-space(.)='Undo direct edits']",
    );
    await until(
      "reverting from the completion notice to autosave the selected baseline",
      async () => (await readFile(draft)).equals(Buffer.from(liveManuscript)) || null,
    ).catch(explain);
    await clickPath("//section[@aria-label='Ask AI']//button[normalize-space(.)='Close']");

    const reviewSource = "**Opening line.**\r\n\r\nKeep this.  \n\nClosing line.";
    await writeFile(draft, `\uFEFF${reviewSource}`);
    await waitForView(
      "the replacement draft from disk",
      "return document.querySelector('.cm-content')?.textContent.includes('Closing line.');",
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
      stream: false,
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
    await clickPath("//section[@aria-label='Ask AI']//button[normalize-space(.)='Close']");
    await keyActions(chord(keys.control, "z"));
    await until(
      "undo to preserve the external edit",
      async () => (await readFile(draft, "utf8")) === externallyEdited || null,
    ).catch(explain);
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
});

test("a saved writing review resumes after a native restart without contacting its model", async () => {
  const draft = join(dir, "resume-writing-review.md");
  const renamedDraft = join(dir, "renamed-writing-review.md");
  const original = "First draft.\n\nSecond draft.\n\nThird draft.\n\nLast draft.";
  const replacement = "First edit.\n\nSecond edit.\n\nThird edit.\n\nLast edit.";
  const instruction = "Review all four passages.";
  const excerpt = "The Tuesday field notes support the first passage.";
  const requests: { messages: { content: string }[] }[] = [];
  let connectionId: string | undefined;
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
    await clickPath(
      "//fieldset[@aria-label='Proposed edit 1 of 4']//button[normalize-space(.)='Apply proposed edit']",
    );
    await clickPath(
      "//fieldset[@aria-label='Proposed edit 2 of 4']//button[normalize-space(.)='Dismiss proposed edit']",
    );
    assert.deepEqual(JSON.parse(requests[0]?.messages.at(-1)?.content ?? ""), {
      instruction,
      selectedText: original,
      taskContext: { materials: [{ name: "Pasted text", text: excerpt }] },
    });
    await waitForView(
      "the manuscript caret to regain focus",
      `
      const editor = document.querySelector('.cm-content');
      editor?.focus();
      return editor === document.activeElement;
    `,
    );
    await keyActions(chord(keys.control, keys.end));
    await clickPath("//section[@aria-label='Ask AI']//button[normalize-space(.)='Close']");
    await nativeShortcut("ctrl+s");
    const accepted = original.replace("First draft.", "First edit.");
    await until(
      "the accepted text to reach disk",
      async () => (await readFile(draft, "utf8")) === accepted || null,
    ).catch(explain);
    const history = await until("the accepted document history to be recorded", async () => {
      const versions = await invokeNative<number[]>("list_versions", { path: draft });
      return versions.length ? versions : null;
    }).catch(explain);
    const [review] = await invokeNative<unknown[]>("list_writing_tasks", { path: draft });
    assert.ok(review);
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
      const field = index => pane?.querySelector('fieldset[aria-label="Proposed edit ' + index + ' of 4"]');
      const button = (index, label) => [...field(index)?.querySelectorAll('button') ?? []].some(el => el.textContent.trim() === label);
      return field(1)?.innerText.includes('Applied to the selected text.') &&
        field(2)?.innerText.includes('Proposed edit dismissed.') &&
        field(3)?.innerText.includes('External third.') && button(3, 'Apply to compared text') &&
        button(4, 'Apply proposed edit');
    `,
    );
    await clickPath(
      "//aside[@aria-label='Writing Assistant']//summary[normalize-space(.)='Pasted text']",
    );
    await shows(excerpt);
    assert.equal(requests.length, 1);
    await clickPath("//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Close']");
    await waitForView(
      "the saved reading position",
      `
      const node = window.getSelection()?.focusNode;
      const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line');
      return line?.textContent === 'Last draft.';
    `,
    );
    assert.equal(await readFile(renamedDraft, "utf8"), changed);
    assert.deepEqual(
      await invokeNative<number[]>("list_versions", { path: renamedDraft }),
      history,
    );
    await click("Writing tasks");
    await click(instruction);
    const first = "//fieldset[@aria-label='Proposed edit 1 of 4']";
    await clickPath(`${first}//button[normalize-space(.)='Revert this edit']`);
    await clickPath("//aside[@aria-label='Writing Assistant']//button[normalize-space(.)='Close']");
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
    await chooseSettingsOption("Inline completion", name);
    await click("Close");
    await clickPath("//main//div[@role='textbox']");
    await keyActions([...chord(keys.control, keys.end), ...typing(" trail")]);
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

    await keyActions(typing(keys.tab));
    await nativeShortcut("ctrl+s");
    await until(
      "Tab to save the continuation with the original line endings",
      async () => (await readFile(draft, "utf8")) === `${initial} trail${continuation}` || null,
    ).catch(explain);

    await openSettings();
    await chooseSettingsOption("Inline completion", "Off");
    await click("Close");
    await clickPath("//main//div[@role='textbox']");
    await keyActions([...chord(keys.control, keys.end), ...typing(" Today.")]);
    await nativeShortcut("ctrl+s");
    await until(
      "writing after switching inline completion off",
      async () =>
        (await readFile(draft, "utf8")) === `${initial} trail${continuation} Today.` || null,
    ).catch(explain);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(requests.length, 1, "switching inline completion off stops subsequent requests");
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
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
    await clickPath("//div[contains(@class,'cm-content') and contains(.,'A speeling error.')]");
    await keyActions(chord(keys.control, keys.home));
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
    assert.deepEqual(requests, [], "setting up a model does not send the manuscript");
    await clickPath(checkbox);
    await click("Close");
    await clickPath(
      "//section[@aria-label='Proofreading suggestion']//button[normalize-space(.)='Apply correction']",
    );
    assert.ok(requests[0], "the correction arrived from the fixture endpoint");
    const { url, authorization, body } = requests[0];
    assert.equal(url, "/v1/chat/completions");
    assert.equal(authorization, `Bearer ${secret}`);
    const { model, messages } = body as { model: string; messages: { content: string }[] };
    assert.equal(model, "native-proofreader");
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.ok(message);
    assert.equal(JSON.parse(message.content).selectedText, "A speeling error.");
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

test("a native model reply stays editable and untitled until the author chooses a Save As path", async () => {
  const folder = await mkdtemp(join(homedir(), "mint-ai-draft-"));
  const sources = join(folder, "sources");
  const source = join(sources, "field-log.md");
  const excerpt = "The north ridge reopened on Tuesday.";
  const unapproved = "Private crew contact details.";
  await mkdir(sources);
  await writeFile(source, `${unapproved}\n${excerpt}\n`);
  const path = join(folder, "field-notes.md");
  const instruction = "Draft an introduction for the field notes.";
  const generated = "Field notes from the ridge.";
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
        : generated;
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
    await until("the original manuscript to open", () =>
      command<boolean>("POST", `/session/${session}/execute/sync`, {
        script: "return !!document.querySelector('.cm-content')",
        args: [],
      }).then((ready) => ready || null),
    ).catch(explain);
    await nativeShortcut("ctrl+n");
    await click("Draft with AI");

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
    assert.equal(requests.length, 2);
    const initialContext = {
      materials: [{ name: "Pasted text", text: "Field notes are for the visitor bulletin." }],
      folderSearch: true,
    };
    for (const [index, request] of requests.entries()) {
      assert.equal(request.path, "/v1/chat/completions");
      assert.equal(request.method, "POST");
      assert.equal(request.authorization, "Bearer draft-fixture-secret");
      assert.equal(request.body.model, "native-draft-fixture");
      assert.equal(request.body.stream, false);
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
  } finally {
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
});

async function addPastedWritingMaterial(text: string) {
  await clickPath("//form//summary[normalize-space(.)='Add files or paste text']");
  await clickPath("//form//label[normalize-space(.)='Pasted material']/textarea");
  await keyActions(typing(text));
  await clickPath("//form//button[normalize-space(.)='Add pasted text']");
}

const credentialPolicy = process.env.MINT_SMOKE_CREDENTIAL_POLICY;
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

test("external Agent consent gates a real CLI process and keeps the manuscript out of its input", async () => {
  const fixture = await mkdtemp(join(dir, "external-agent-"));
  const draft = join(fixture, "draft.md");
  const executable = join(fixture, "fixture-codex");
  const calls = join(fixture, "calls.jsonl");
  const writeTarget = join(fixture, "agent-write.txt");
  const initial = "Unsent paragraph.\n\nOn-disk sentence.";
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
  args, prompt, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), readable,
}) + "\\n");
if (prompt.instruction === "Is the selected line clear?") fs.writeFileSync("review-copy.md", prompt.selectedText);
if (!readOnly) fs.writeFileSync(${JSON.stringify(writeTarget)}, "configured access ran");
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Fixture Agent reply." } }));
console.log(JSON.stringify({ type: "turn.completed" }));
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
  await command("POST", `/session/${session}/execute/sync`, {
    script: `const action = document.querySelector('section[aria-label="Ask AI"] select');
      action.value = 'comment';
      action.dispatchEvent(new Event('change', { bubbles: true }));`,
    args: [],
  });
  await clickPath("//section[@aria-label='Ask AI']//input");
  await keyActions([...typing("Is the selected line clear?"), ...typing(keys.enter)]);
  await waitForView(
    "the inline reply from the CLI",
    `return document.querySelector('section[aria-label="Ask AI"] textarea')?.value === 'Fixture Agent reply.' &&
      !document.querySelector('aside[aria-label="Writing Assistant"]');`,
  );
  await click("Continue in sidebar");
  await command("POST", `/session/${session}/execute/sync`, {
    script: `const scope = [...document.querySelectorAll('aside[aria-label="Writing Assistant"] select')]
      .find((select) => select.querySelector('option[value="instruction"]'));
      scope.value = 'instruction';
      scope.dispatchEvent(new Event('change', { bubbles: true }));`,
    args: [],
  });
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
  assert.deepEqual(
    selectedCalls.map((entry) => entry.prompt),
    [
      { instruction: "Is the selected line clear?", selectedText: "On-disk sentence." },
      {
        instruction: "What would help?",
        history: [{ instruction: "Is the selected line clear?", reply: "Fixture Agent reply." }],
      },
    ],
  );
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
  await openSettings();
  await click("External Agents");

  await command("POST", `/session/${session}/execute/sync`, {
    script: `const select = Array.from(document.querySelectorAll('dialog[open] select'))
      .find((control) => control.querySelector('option[value="configured"]'));
      select.value = 'configured';
      select.dispatchEvent(new Event('change', { bubbles: true }));`,
    args: [],
  });
  await shows("Configured file access may include writes across your account.");
  await click("Try example");
  await click("Decline");
  await assert.rejects(
    invokeNative("send_external_agent", { path, revision, access: "configured", request }),
    /agentAccessRequired/,
  );
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 3);
  await assert.rejects(readFile(writeTarget), { code: "ENOENT" });

  await click("Try example");
  await click("Allow and send");
  await shows("Fixture Agent reply.");
  assert.equal(await readFile(writeTarget, "utf8"), "configured access ran");
  assert.equal(await readFile(draft, "utf8"), initial);

  // Reopening the task after a native restart makes no CLI call. Deleting it clears its copies.
  await click("Close");
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
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 4);
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
  await click("External Agents");
  await shows(executable);
  await click("Try example");
  await shows("Fixture Agent reply.");
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 5);
  await click("Close");
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

  await openSettings();
  await click("External Agents");
  await writeFile(
    executable,
    `${await readFile(executable, "utf8")}
// replacement
`,
  );
  await click("Try example");
  await shows("Agent access changed. Review its permissions before sending.");
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 6);
  // The warning can render before reinspection finishes and enables the retry.
  await clickSettingsButton("Try example");
  await click("Decline");
  await shows("Agent access declined.");
  await click("Forget Agent");
  await click("Close");
});
