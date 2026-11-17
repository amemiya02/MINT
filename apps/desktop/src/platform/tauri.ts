import { Channel, invoke } from "@tauri-apps/api/core";
import {
  Menu,
  MenuItem,
  PredefinedMenuItem,
  type PredefinedMenuItemOptions,
  Submenu,
} from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { DirectoryEntry, MenuItemSpec, Platform } from "./platform.ts";

const nativeItems = {
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "SelectAll",
  quit: "Quit",
} as const satisfies Record<string, PredefinedMenuItemOptions["item"]>;

/** Platform implementation for the desktop app: Tauri IPC to the Rust backend. */
export function createTauriPlatform(): Platform {
  return {
    locale: navigator.language,
    readTextFile: (path) => invoke<string>("read_text_file", { path }),
    writeTextFile: (path, text) => invoke<void>("write_text_file", { path, text }),
    async showOpenDialog({ title, filters }) {
      const picked = await open({
        title,
        multiple: false,
        directory: false,
        filters: filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
      });
      return picked ?? null;
    },
    async showOpenFolderDialog({ title }) {
      return (await open({ title, multiple: false, directory: true })) ?? null;
    },
    readDirectory: (path) => invoke<DirectoryEntry[]>("read_directory", { path }),
    createFile: (path) => invoke<void>("create_file", { path }),
    createDirectory: (path) => invoke<void>("create_directory", { path }),
    rename: (from, to) => invoke<void>("rename_path", { from, to }),
    moveToTrash: (path) => invoke<void>("move_to_trash", { path }),
    async watchFolder(path, onChange) {
      const channel = new Channel<string[]>();
      channel.onmessage = onChange;
      const id = await invoke<number>("watch_folder", { path, onChange: channel });
      return () => void invoke<void>("unwatch_folder", { id });
    },
    readAppData: (name) => invoke<string | null>("read_app_data", { name }),
    writeAppData: (name, text) => invoke<void>("write_app_data", { name, text }),
    setWindowTitle: (title) => getCurrentWindow().setTitle(title),
    async setMenu(menu) {
      const submenus = await Promise.all(
        menu.map(async (m) =>
          Submenu.new({ text: m.label, items: await Promise.all(m.items.map(toNativeItem)) }),
        ),
      );
      const appMenu = await Menu.new({ items: submenus });
      await appMenu.setAsAppMenu();
    },
  };
}

function toNativeItem(item: MenuItemSpec) {
  switch (item.kind) {
    case "command":
      return MenuItem.new({
        id: item.id,
        text: item.label,
        ...(item.accelerator ? { accelerator: item.accelerator } : {}),
        action: () => item.run(),
      });
    case "separator":
      return PredefinedMenuItem.new({ item: "Separator" });
    case "native":
      return PredefinedMenuItem.new({ item: nativeItems[item.action], text: item.label });
  }
}

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
