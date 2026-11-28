import type { EditorCommand, EditorCommands } from "@mint/editor";
import type { MessageKey, Translate } from "./i18n/index.ts";
import { isMac, sameShortcut } from "./keys.ts";
import type { MenuItemSpec, MenuSpec } from "./platform/platform.ts";
import type { ShortcutOverrides } from "./settings/schema.ts";

/**
 * The command registry. Every user-invocable action is a command with an id,
 * an i18n title and an optional default shortcut. The native menu, the
 * command palette and the shortcuts (which are menu accelerators) are all
 * derived from this one list, so registering a command here is all it takes
 * to make it reachable everywhere.
 *
 * Shell commands are run by the window's handlers (see `App.tsx`). Editor
 * commands name an editor core command (with its arguments) and run on the
 * active document; the shell needs no handler for them.
 */

/** A named editor core command and its arguments, e.g. `["setHeading", 2]`. */
export type EditorInvocation = {
  [C in EditorCommand]: readonly [C, ...EditorCommands[C]];
}[EditorCommand];

/** Native menus, in menu bar order. */
export type MenuId = "app" | "file" | "edit" | "paragraph" | "format" | "view" | "window";

interface CommandSpec {
  readonly id: string;
  readonly title: MessageKey;
  /** Default shortcut in Tauri accelerator syntax; `CmdOrCtrl` is ⌘ on macOS and Ctrl elsewhere. */
  readonly accelerator?: string;
  /** The menu the command appears in. */
  readonly menu: MenuId;
  /** Commands of a menu are separated where their group changes. */
  readonly group?: string;
  /** Present for editor commands: what to run on the active document. */
  readonly editor?: EditorInvocation;
}

const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) =>
  ({
    id: `paragraph.heading${level}`,
    title: `command.paragraph.heading${level}`,
    accelerator: `CmdOrCtrl+${level}`,
    menu: "paragraph",
    group: "heading",
    editor: ["setHeading", level],
  }) as const;

// Default shortcuts follow Typora. Where a key clashes with the system or
// Tauri on some platform, the clash is resolved here and noted.
export const commands = [
  { id: "app.checkForUpdates", title: "command.app.checkForUpdates", menu: "app", group: "update" },
  {
    id: "app.settings",
    title: "command.app.settings",
    accelerator: "CmdOrCtrl+,",
    menu: "app",
    group: "settings",
  },

  { id: "file.new", title: "command.file.new", accelerator: "CmdOrCtrl+N", menu: "file" },
  { id: "file.draftWithAi", title: "command.file.draftWithAi", menu: "file" },
  { id: "file.open", title: "command.file.open", accelerator: "CmdOrCtrl+O", menu: "file" },
  { id: "file.openFolder", title: "command.file.openFolder", menu: "file" },
  {
    id: "file.quickOpen",
    title: "command.file.quickOpen",
    accelerator: "CmdOrCtrl+P",
    menu: "file",
  },
  {
    id: "file.save",
    title: "command.file.save",
    accelerator: "CmdOrCtrl+S",
    menu: "file",
    group: "save",
  },
  {
    id: "file.saveAs",
    title: "command.file.saveAs",
    accelerator: "CmdOrCtrl+Shift+S",
    menu: "file",
    group: "save",
  },
  {
    id: "tab.close",
    title: "command.tab.close",
    accelerator: "CmdOrCtrl+W",
    menu: "file",
    group: "save",
  },
  { id: "file.history", title: "command.file.history", menu: "file", group: "save" },
  { id: "file.export", title: "command.file.export", menu: "file", group: "export" },
  { id: "file.exportHtml", title: "command.file.exportHtml", menu: "file", group: "export" },
  { id: "file.exportPdf", title: "command.file.exportPdf", menu: "file", group: "export" },

  // Typora's shortcut. A plain paste turns rich text from the clipboard into Markdown.
  {
    id: "edit.pastePlainText",
    title: "command.edit.pastePlainText",
    accelerator: "CmdOrCtrl+Shift+V",
    menu: "edit",
    group: "paste",
  },
  { id: "edit.find", title: "command.edit.find", accelerator: "CmdOrCtrl+F", menu: "edit" },
  {
    id: "edit.askAI",
    title: "writing.ask",
    menu: "edit",
    group: "writing",
  },
  { id: "edit.writingTasks", title: "writing.tasks", menu: "edit", group: "writing" },
  {
    id: "edit.askExternalAgent",
    title: "command.edit.askExternalAgent",
    menu: "edit",
    group: "writing",
  },
  // Typora's replace shortcut: ⌘⌥F on macOS, Ctrl+H elsewhere (Ctrl+Alt is AltGr on Windows).
  {
    id: "edit.replace",
    title: "command.edit.replace",
    accelerator: isMac ? "Cmd+Alt+F" : "Ctrl+H",
    menu: "edit",
  },
  {
    id: "edit.searchFolder",
    title: "command.edit.searchFolder",
    accelerator: "CmdOrCtrl+Shift+F",
    menu: "edit",
  },
  // ⌘D as in VS Code and Sublime Text: add a cursor at the next occurrence.
  {
    id: "edit.selectNextOccurrence",
    title: "command.edit.selectNextOccurrence",
    accelerator: "CmdOrCtrl+D",
    menu: "edit",
    group: "selection",
    editor: ["selectNextOccurrence"],
  },
  {
    id: "edit.toggleSpellcheck",
    title: "command.edit.toggleSpellcheck",
    menu: "edit",
    group: "spelling",
  },
  {
    id: "edit.toggleProofreading",
    title: "command.edit.toggleProofreading",
    menu: "edit",
    group: "spelling",
  },
  {
    id: "edit.addAnnotation",
    title: "command.edit.addAnnotation",
    accelerator: "CmdOrCtrl+Alt+M",
    menu: "edit",
    group: "annotations",
  },
  {
    id: "edit.reviewDocument",
    title: "command.edit.reviewDocument",
    menu: "edit",
    group: "annotations",
  },
  {
    id: "view.annotations",
    title: "command.view.annotations",
    menu: "view",
    group: "sidebar",
  },

  heading(1),
  heading(2),
  heading(3),
  heading(4),
  heading(5),
  heading(6),
  {
    id: "paragraph.paragraph",
    title: "command.paragraph.paragraph",
    accelerator: "CmdOrCtrl+0",
    menu: "paragraph",
    group: "heading",
    editor: ["setParagraph"],
  },
  {
    id: "paragraph.codeBlock",
    title: "command.paragraph.codeBlock",
    accelerator: "CmdOrCtrl+Shift+K",
    menu: "paragraph",
    group: "blocks",
    editor: ["insertCodeBlock"],
  },
  {
    id: "paragraph.table",
    title: "command.paragraph.table",
    accelerator: "CmdOrCtrl+T",
    menu: "paragraph",
    group: "blocks",
    editor: ["insertTable"],
  },
  {
    id: "paragraph.formatTable",
    title: "command.paragraph.formatTable",
    menu: "paragraph",
    group: "table",
    editor: ["formatTable"],
  },

  {
    id: "format.bold",
    title: "command.format.bold",
    accelerator: "CmdOrCtrl+B",
    menu: "format",
    editor: ["toggleBold"],
  },
  {
    id: "format.italic",
    title: "command.format.italic",
    accelerator: "CmdOrCtrl+I",
    menu: "format",
    editor: ["toggleItalic"],
  },
  {
    id: "format.link",
    title: "command.format.link",
    accelerator: "CmdOrCtrl+K",
    menu: "format",
    editor: ["toggleLink"],
  },

  {
    id: "view.commandPalette",
    title: "command.view.commandPalette",
    accelerator: "CmdOrCtrl+Shift+P",
    menu: "view",
  },
  {
    id: "view.toggleSidebar",
    title: "command.view.toggleSidebar",
    accelerator: "CmdOrCtrl+Shift+L",
    menu: "view",
    group: "layout",
  },
  {
    id: "view.previewLink",
    title: "command.view.previewLink",
    accelerator: "CmdOrCtrl+Alt+Enter",
    menu: "view",
    group: "layout",
    editor: ["previewLink"],
  },
  { id: "view.toolbarTop", title: "command.view.toolbarTop", menu: "view", group: "toolbar" },
  { id: "view.toolbarSide", title: "command.view.toolbarSide", menu: "view", group: "toolbar" },
  { id: "view.toolbarHide", title: "command.view.toolbarHide", menu: "view", group: "toolbar" },
  {
    id: "view.openInOtherPane",
    title: "command.view.openInOtherPane",
    menu: "view",
    group: "layout",
  },
  {
    id: "view.focusOtherPane",
    title: "command.view.focusOtherPane",
    menu: "view",
    group: "layout",
  },
  {
    id: "view.closeReferencePane",
    title: "command.view.closeReferencePane",
    menu: "view",
    group: "layout",
  },
  // Typora's outline shortcut: ⌃⌘1 on macOS, Ctrl+Shift+1 elsewhere.
  {
    id: "view.outline",
    title: "command.view.outline",
    accelerator: isMac ? "Cmd+Ctrl+1" : "Ctrl+Shift+1",
    menu: "view",
    group: "layout",
  },
  {
    id: "view.toggleSourceMode",
    title: "command.view.toggleSourceMode",
    accelerator: "CmdOrCtrl+/",
    menu: "view",
    group: "layout",
    editor: ["toggleSourceMode"],
  },
  // Typora's shortcuts. Both flip a setting, so they apply to every document and window.
  {
    id: "view.toggleFocusMode",
    title: "command.view.toggleFocusMode",
    accelerator: "F8",
    menu: "view",
    group: "writing",
  },
  {
    id: "view.toggleTypewriterMode",
    title: "command.view.toggleTypewriterMode",
    accelerator: "F9",
    menu: "view",
    group: "writing",
  },
  { id: "view.toggleVimMode", title: "command.view.toggleVimMode", menu: "view", group: "layout" },

  {
    id: "window.new",
    title: "command.window.new",
    accelerator: "CmdOrCtrl+Shift+N",
    menu: "window",
  },
  {
    id: "tab.next",
    title: "command.tab.next",
    accelerator: "Ctrl+Tab",
    menu: "window",
    group: "tabs",
  },
  {
    id: "tab.previous",
    title: "command.tab.previous",
    accelerator: "Ctrl+Shift+Tab",
    menu: "window",
    group: "tabs",
  },
] as const satisfies readonly CommandSpec[];

type Registered = (typeof commands)[number];
export type CommandId = Registered["id"];
/** Commands that run an editor core command on the active document. */
export type EditorCommandId = Extract<Registered, { editor: EditorInvocation }>["id"];
/** Commands the shell window handles itself. */
export type ShellCommandId = Exclude<CommandId, EditorCommandId>;
export type Command = CommandSpec & { readonly id: CommandId };

export function findCommand(id: CommandId): Command {
  const command = (commands as readonly Command[]).find((c) => c.id === id);
  if (!command) throw new Error(`Unknown command: ${id}`);
  return command;
}

export function isCommandId(id: string): id is CommandId {
  return (commands as readonly Command[]).some((c) => c.id === id);
}

/**
 * The shortcut a command has with the user's overrides (the `shortcuts` setting)
 * applied: the override if there is one (`null` for none), else the default.
 */
export function shortcutOf(command: Command, overrides: ShortcutOverrides): string | undefined {
  const override = Object.hasOwn(overrides, command.id) ? overrides[command.id] : undefined;
  if (override === null) return undefined;
  return override ?? command.accelerator;
}

/** The commands other than `except` whose shortcut is `accelerator`, in registry order. */
export function commandsWithShortcut(
  accelerator: string,
  overrides: ShortcutOverrides,
  except?: CommandId,
): Command[] {
  return (commands as readonly Command[]).filter((command) => {
    const shortcut = shortcutOf(command, overrides);
    return command.id !== except && shortcut !== undefined && sameShortcut(shortcut, accelerator);
  });
}

/** Menu bar layout: native items around the registry's commands. */
const menus: readonly {
  readonly id: MenuId;
  readonly label: MessageKey;
  readonly before?: readonly NativeItem[];
  readonly after?: readonly NativeItem[];
}[] = [
  { id: "app", label: "menu.app", after: ["separator", "quit"] },
  { id: "file", label: "menu.file" },
  {
    id: "edit",
    label: "menu.edit",
    before: ["cut", "copy", "paste", "separator", "selectAll", "separator"],
  },
  { id: "paragraph", label: "menu.paragraph" },
  { id: "format", label: "menu.format" },
  { id: "view", label: "menu.view" },
  { id: "window", label: "menu.window" },
];

type NativeItem = "separator" | "cut" | "copy" | "paste" | "selectAll" | "quit";

/**
 * The menu bar. Item accelerators are the active shortcuts: the defaults with the
 * user's `overrides` applied, or none at all while `shortcutsActive` is false
 * (e.g. while a new shortcut is being recorded, so pressing it runs nothing).
 */
export function buildMenu(
  t: Translate,
  run: (id: CommandId) => void,
  overrides: ShortcutOverrides = {},
  shortcutsActive = true,
): MenuSpec[] {
  const native = (item: NativeItem): MenuItemSpec =>
    item === "separator"
      ? { kind: "separator" }
      : { kind: "native", action: item, label: t(`menu.${item}`) };
  return menus.map((menu) => {
    const items: MenuItemSpec[] = (menu.before ?? []).map(native);
    let group: string | undefined;
    (commands as readonly Command[])
      .filter((command) => command.menu === menu.id)
      .forEach((command, index) => {
        if (index > 0 && command.group !== group) items.push({ kind: "separator" });
        group = command.group;
        const accelerator = shortcutsActive ? shortcutOf(command, overrides) : undefined;
        items.push({
          kind: "command",
          id: command.id,
          label: t(command.title),
          ...(accelerator ? { accelerator } : {}),
          run: () => run(command.id),
        });
      });
    items.push(...(menu.after ?? []).map(native));
    return { label: t(menu.label), items };
  });
}
