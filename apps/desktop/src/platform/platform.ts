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
   * Search the text of the files of a folder (the same files `listFolderFiles`
   * lists) in the background. Each file with matches is passed to `onFile` as
   * soon as it is searched, in path order; `onDone` is called last, unless the
   * search is cancelled. Rejects at once if `query.regexp` is set and the pattern
   * is not a valid regular expression. Resolves to a function that cancels it.
   */
  searchFolder(
    path: string,
    query: FolderSearchQuery,
    extensions: readonly string[],
    listener: FolderSearchListener,
  ): Promise<() => void>;

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

export interface FolderSearchQuery {
  readonly pattern: string;
  readonly caseSensitive: boolean;
  /** Only matches not preceded or followed by a letter, digit or underscore. */
  readonly wholeWord: boolean;
  /** `pattern` is a regular expression; otherwise it is literal text. */
  readonly regexp: boolean;
}

export interface FolderSearchListener {
  onFile(file: FileMatches): void;
  /** `truncated`: the search stopped after too many matching lines. */
  onDone(summary: { readonly truncated: boolean }): void;
}

/** The matching lines of one file. */
export interface FileMatches {
  readonly path: string;
  readonly lines: readonly LineMatch[];
}

export interface LineMatch {
  /** 1-based line number (lines end at a line feed). */
  readonly line: number;
  /** The line without its line ending; a byte order mark on line 1 is kept. */
  readonly text: string;
  /** The matches in `text` as `[start, end)` UTF-16 offsets. */
  readonly ranges: readonly (readonly [number, number])[];
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
