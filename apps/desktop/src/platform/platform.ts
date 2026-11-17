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

  /** Ask the user to pick a folder. Resolves to its path, or `null` if cancelled. */
  showOpenFolderDialog(options: { readonly title: string }): Promise<string | null>;

  /** List the direct children of a directory, in no particular order. */
  readDirectory(path: string): Promise<DirectoryEntry[]>;

  /**
   * Every file of a folder, recursively, as absolute paths. Entries ignored by a
   * `.gitignore` in the folder (whether or not it is a git repository) and hidden
   * entries (names starting with a dot) are left out. When `extensions` is not
   * empty, only files with one of them (case-insensitive, without the dot) are listed.
   */
  listFolderFiles(path: string, extensions: readonly string[]): Promise<string[]>;

  /**
   * Save an asset (e.g. a pasted image) into `directory`, creating it (and its
   * parents) if needed. The file is named `fileName`, or `name-1.ext`,
   * `name-2.ext`... if that name is taken: nothing is ever overwritten.
   * Resolves to the absolute path of the new file.
   */
  saveAsset(directory: string, fileName: string, data: Uint8Array): Promise<string>;

  /**
   * A URL the page can load to show the local file at `path` (an image in a
   * document), or `null` if it cannot be shown. The file may not exist; then
   * loading the URL fails.
   */
  assetUrl(path: string): string | null;

  /** Create an empty file. Rejects if anything already exists at `path`. */
  createFile(path: string): Promise<void>;

  /** Create a directory. Rejects if anything already exists at `path`. */
  createDirectory(path: string): Promise<void>;

  /** Rename a file or directory. Rejects rather than replace an existing entry. */
  rename(from: string, to: string): Promise<void>;

  /** Move a file or directory to the system trash (never a permanent delete). */
  moveToTrash(path: string): Promise<void>;

  /**
   * Watch a folder recursively. `onChange` receives the paths touched by each
   * batch of changes, MINT's own included. Resolves to a function that stops watching.
   */
  watchFolder(path: string, onChange: (paths: readonly string[]) => void): Promise<() => void>;

  /**
   * Read a small named file from MINT's app data directory (where MINT keeps
   * its own state, never in a folder the user opened), or `null` if absent.
   */
  readAppData(name: string): Promise<string | null>;

  /** Write a small named file to MINT's app data directory, atomically. */
  writeAppData(name: string, text: string): Promise<void>;
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

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
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
