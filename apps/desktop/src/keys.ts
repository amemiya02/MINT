/**
 * Shortcuts are written once, in Tauri accelerator syntax (`CmdOrCtrl+Shift+K`),
 * and shown the way each platform writes them: `⇧⌘K` on macOS, `Ctrl+Shift+K`
 * on Windows and Linux, where ⌘ becomes Ctrl.
 */

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type Modifier = "ctrl" | "alt" | "shift" | "meta";

interface Parsed {
  readonly modifiers: ReadonlySet<Modifier>;
  readonly key: string;
}

function parse(accelerator: string, mac: boolean): Parsed {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const modifiers = new Set<Modifier>();
  for (const part of parts.map((p) => p.toLowerCase())) {
    if (part === "cmdorctrl" || part === "commandorcontrol") modifiers.add(mac ? "meta" : "ctrl");
    else if (part === "cmd" || part === "command" || part === "super" || part === "meta") {
      modifiers.add("meta");
    } else if (part === "ctrl" || part === "control") modifiers.add("ctrl");
    else if (part === "alt" || part === "option") modifiers.add("alt");
    else if (part === "shift") modifiers.add("shift");
  }
  return { modifiers, key };
}

const macSymbols: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const otherNames: Record<Modifier, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Win",
};
// Apple's order is ⌃⌥⇧⌘; elsewhere Ctrl+Alt+Shift.
const order: readonly Modifier[] = ["ctrl", "alt", "shift", "meta"];

/** How the platform writes a shortcut, e.g. `⇧⌘K` or `Ctrl+Shift+K`. */
export function formatAccelerator(accelerator: string, mac = isMac): string {
  const { modifiers, key } = parse(accelerator, mac);
  const held = order.filter((m) => modifiers.has(m));
  const name = key.length === 1 ? key.toUpperCase() : key;
  return mac
    ? held.map((m) => macSymbols[m]).join("") + name
    : [...held.map((m) => otherNames[m]), name].join("+");
}

const ariaNames: Record<Modifier, string> = {
  ctrl: "Control",
  alt: "Alt",
  shift: "Shift",
  meta: "Meta",
};

/** The shortcut in `aria-keyshortcuts` syntax, e.g. `Meta+Shift+K`. */
export function ariaKeyShortcut(accelerator: string, mac = isMac): string {
  const { modifiers, key } = parse(accelerator, mac);
  const held = order.filter((m) => modifiers.has(m)).map((m) => ariaNames[m]);
  return [...held, key.length === 1 ? key.toUpperCase() : key].join("+");
}
