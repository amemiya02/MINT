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

  /** Ask a three-way question (e.g. save / don't save / cancel). Dismissing the dialog answers `cancel`. */
  showQuestionDialog(options: QuestionDialogOptions): Promise<"yes" | "no" | "cancel">;

  /** Open a URL (`https:`, `mailto:`, ...) in the user's default browser or handler. */
  openExternal(url: string): Promise<void>;

  setWindowTitle(title: string): Promise<void>;

  /** Install the application menu for this window. Item accelerators are active shortcuts. */
  setMenu(menu: readonly MenuSpec[]): Promise<void>;

  /** Open a new, independent window of the shell. */
  openWindow(): Promise<void>;

  /** Ask to close this window; it goes through the close-request handler like a click on its close button. */
  closeWindow(): Promise<void>;

  /**
   * Intercept requests to close this window. The window closes only if the
   * handler resolves to `true`. Returns an unsubscribe function.
   */
  onCloseRequested(handler: () => Promise<boolean>): () => void;

  /** Absolute path of settings.json in the system configuration directory. */
  settingsPath(): Promise<string>;

  /** Read and parse settings.json. Values are not validated; that is the shell's job. */
  readSettings(): Promise<SettingsFile>;

  /** Replace settings.json with `values`, pretty-printed, atomically. */
  writeSettings(values: SettingsValues): Promise<void>;

  /**
   * Call `listener` with the reloaded file whenever settings.json changes on disk,
   * whoever changed it. Returns a function that stops listening.
   */
  onSettingsChanged(listener: (file: SettingsFile) => void): () => void;
}

export interface QuestionDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly yes: string;
  readonly no: string;
  readonly cancel: string;
}

/** The raw key/value pairs of settings.json. */
export type SettingsValues = Readonly<Record<string, unknown>>;

/** What settings.json currently holds. */
export type SettingsFile =
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly values: SettingsValues }
  /** Unreadable or not a JSON object; `message` says why (e.g. a syntax error and its line). */
  | { readonly status: "invalid"; readonly message: string };

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
