import type { MessageKey, Translate } from "./i18n/index.ts";
import type { MenuSpec } from "./platform/platform.ts";

/**
 * The command registry. Every user-invocable action is a command with an id,
 * an i18n title and an optional default shortcut; the native menu (and later
 * the command palette and shortcut overrides) are derived from this list.
 */
export type CommandId =
  | "file.open"
  | "file.save"
  | "tab.close"
  | "tab.next"
  | "tab.previous"
  | "window.new";

export interface Command {
  readonly id: CommandId;
  readonly title: MessageKey;
  /** Default shortcut in Tauri accelerator syntax. */
  readonly accelerator?: string;
}

export const commands: readonly Command[] = [
  { id: "file.open", title: "command.file.open", accelerator: "CmdOrCtrl+O" },
  { id: "file.save", title: "command.file.save", accelerator: "CmdOrCtrl+S" },
  { id: "tab.close", title: "command.tab.close", accelerator: "CmdOrCtrl+W" },
  { id: "tab.next", title: "command.tab.next", accelerator: "Ctrl+Tab" },
  { id: "tab.previous", title: "command.tab.previous", accelerator: "Ctrl+Shift+Tab" },
  { id: "window.new", title: "command.window.new", accelerator: "CmdOrCtrl+Shift+N" },
];

export function buildMenu(t: Translate, run: (id: CommandId) => void): MenuSpec[] {
  const item = (id: CommandId) => {
    const command = commands.find((c) => c.id === id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    return {
      kind: "command" as const,
      id,
      label: t(command.title),
      ...(command.accelerator ? { accelerator: command.accelerator } : {}),
      run: () => run(id),
    };
  };
  return [
    { label: t("menu.app"), items: [{ kind: "native", action: "quit", label: t("menu.quit") }] },
    {
      label: t("menu.file"),
      items: [item("file.open"), item("file.save"), { kind: "separator" }, item("tab.close")],
    },
    {
      label: t("menu.edit"),
      items: [
        { kind: "native", action: "cut", label: t("menu.cut") },
        { kind: "native", action: "copy", label: t("menu.copy") },
        { kind: "native", action: "paste", label: t("menu.paste") },
        { kind: "separator" },
        { kind: "native", action: "selectAll", label: t("menu.selectAll") },
      ],
    },
    {
      label: t("menu.window"),
      items: [item("window.new"), { kind: "separator" }, item("tab.next"), item("tab.previous")],
    },
  ];
}
