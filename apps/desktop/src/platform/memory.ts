import type { MenuItemSpec, MenuSpec, Platform } from "./platform.ts";

export interface MemoryPlatformOptions {
  /** Initial files, keyed by path. */
  readonly files?: Readonly<Record<string, string>>;
  /** Paths the open dialog returns, in order; `null` simulates cancelling. */
  readonly openDialogResults?: readonly (string | null)[];
  readonly locale?: string;
}

/** Platform implementation backed by memory, for E2E tests and the future web build. */
export interface MemoryPlatform extends Platform {
  /** Current file contents, keyed by path. */
  readonly files: Map<string, string>;
  readonly windowTitle: string;
  /** URLs passed to `openExternal`, in order. */
  readonly openedUrls: readonly string[];
  /** Activate a menu item by id, as a click in a native menu would. */
  runMenuItem(id: string): void;
}

export function createMemoryPlatform(options: MemoryPlatformOptions = {}): MemoryPlatform {
  const files = new Map(Object.entries(options.files ?? {}));
  const dialogResults = [...(options.openDialogResults ?? [])];
  let commands: Extract<MenuItemSpec, { kind: "command" }>[] = [];
  let windowTitle = "";
  const openedUrls: string[] = [];

  // Without a native menu, accelerators are handled in the page.
  window.addEventListener("keydown", (event) => {
    const command = commands.find((c) => c.accelerator && matchesAccelerator(event, c.accelerator));
    if (!command) return;
    event.preventDefault();
    command.run();
  });

  return {
    locale: options.locale ?? navigator.language,
    files,
    openedUrls,
    get windowTitle() {
      return windowTitle;
    },
    async readTextFile(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`No such file: ${path}`);
      return text;
    },
    async writeTextFile(path, text) {
      files.set(path, text);
    },
    async showOpenDialog() {
      return dialogResults.shift() ?? null;
    },
    async openExternal(url) {
      openedUrls.push(url);
    },
    async setWindowTitle(title) {
      windowTitle = title;
      document.title = title;
    },
    async setMenu(menu: readonly MenuSpec[]) {
      commands = menu.flatMap((m) => m.items.filter((i) => i.kind === "command"));
    },
    runMenuItem(id) {
      const command = commands.find((c) => c.id === id);
      if (!command) throw new Error(`No menu item: ${id}`);
      command.run();
    },
  };
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function matchesAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  const parts = accelerator.split("+");
  const key = parts.pop()?.toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const primary = mods.has("cmdorctrl") || mods.has("commandorcontrol");
  const wantMeta = mods.has("cmd") || mods.has("command") || (primary && isMac);
  const wantCtrl = mods.has("ctrl") || mods.has("control") || (primary && !isMac);
  return (
    event.key.toLowerCase() === key &&
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.shiftKey === mods.has("shift") &&
    event.altKey === (mods.has("alt") || mods.has("option"))
  );
}
