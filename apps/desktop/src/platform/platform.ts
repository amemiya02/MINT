/**
 * The platform interface: the only way the shell reaches the outside world
 * (file system, dialogs, window, native menu). Two implementations exist:
 * `tauri.ts` (desktop, via IPC to the Rust backend) and `memory.ts`
 * (tests and the future web build). Shell code must never import Tauri
 * packages directly.
 */
export interface Platform {
  /** The user's preferred UI language as a BCP 47 tag, e.g. `zh-CN` or `en-US`. */
  readonly locale: string;

  /**
   * Read a document as UTF-8 text, exactly as stored: a byte order mark is kept
   * as a leading U+FEFF and line endings are untouched. Rejects if the file is
   * missing or not valid UTF-8.
   */
  readTextFile(path: string): Promise<string>;

  /** Write text as UTF-8 atomically: either the whole new content lands or the old file stays intact. */
  writeTextFile(path: string, text: string): Promise<void>;

  /** Ask the user to pick a document. Resolves to its path, or `null` if cancelled. */
  showOpenDialog(options: OpenDialogOptions): Promise<string | null>;

  /** Open a URL (`https:`, `mailto:`, ...) in the user's default browser or handler. */
  openExternal(url: string): Promise<void>;

  setWindowTitle(title: string): Promise<void>;

  /** Install the application menu. Item accelerators are active shortcuts. */
  setMenu(menu: readonly MenuSpec[]): Promise<void>;
}

export interface OpenDialogOptions {
  readonly title: string;
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}

export interface MenuSpec {
  readonly label: string;
  readonly items: readonly MenuItemSpec[];
}

export type MenuItemSpec =
  | {
      readonly kind: "command";
      readonly id: string;
      readonly label: string;
      /** Tauri accelerator syntax, e.g. `CmdOrCtrl+O`. */
      readonly accelerator?: string;
      readonly run: () => void;
    }
  | { readonly kind: "separator" }
  | {
      readonly kind: "native";
      readonly action: "cut" | "copy" | "paste" | "selectAll" | "quit";
      readonly label: string;
    };
