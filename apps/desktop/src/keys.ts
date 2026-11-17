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

const namedKeys =
  /^(F([1-9]|1\d|2[0-4])|Tab|Enter|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Escape)$/;
const modifierNames = new Set([
  "cmdorctrl",
  "commandorcontrol",
  "cmd",
  "command",
  "super",
  "meta",
  "ctrl",
  "control",
  "alt",
  "option",
  "shift",
]);

/**
 * Whether `accelerator` is a shortcut MINT can install: known modifiers, each at
 * most once, then one key (a single character or a named key like `F5` or `Tab`).
 */
export function isAccelerator(accelerator: string): boolean {
  const parts = accelerator.split("+");
  const key = parts.pop() ?? "";
  const modifiers = parts.map((p) => p.toLowerCase());
  return (
    (key.length === 1 ? key.trim() !== "" : namedKeys.test(key)) &&
    modifiers.every((m) => modifierNames.has(m)) &&
    new Set(modifiers).size === modifiers.length
  );
}

/** Whether two accelerators are the same keys on this platform (`CmdOrCtrl+B` is `Cmd+B` on macOS). */
export function sameShortcut(a: string, b: string, mac = isMac): boolean {
  const canonical = (accelerator: string) => {
    const { modifiers, key } = parse(accelerator, mac);
    return [...order.filter((m) => modifiers.has(m)), key.toLowerCase()].join("+");
  };
  return canonical(a) === canonical(b);
}

// Keys are named by their position, so ⇧ and ⌥ do not change what is recorded (⌥F types "ƒ").
const punctuation: Readonly<Record<string, string>> = {
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/** The key part of an accelerator for a physical key, or null for a modifier or an unknown key. */
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^(Digit|Numpad)\d$/.test(code)) return code.slice(-1);
  if (code in punctuation) return punctuation[code] ?? null;
  return namedKeys.test(code) ? code : null;
}

/**
 * The accelerator a key press records, e.g. `CmdOrCtrl+Shift+K`. The platform's
 * primary modifier (⌘ on macOS, Ctrl elsewhere) is written `CmdOrCtrl`, so the
 * shortcut means the same on every platform. Null while only modifiers are down,
 * and for keys pressed without ⌘, Ctrl or Alt, which would get in the way of
 * typing; only function keys may stand alone.
 */
export function acceleratorFromEvent(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac = isMac,
): string | null {
  const key = keyName(event.code);
  if (!key) return null;
  const modifiers = [
    ...((mac ? event.metaKey : event.ctrlKey) ? ["CmdOrCtrl"] : []),
    ...(mac && event.ctrlKey ? ["Ctrl"] : []),
    ...(!mac && event.metaKey ? ["Super"] : []),
    ...(event.altKey ? ["Alt"] : []),
  ];
  if (modifiers.length === 0 && !/^F\d+$/.test(key)) return null;
  return [...modifiers, ...(event.shiftKey ? ["Shift"] : []), key].join("+");
}
