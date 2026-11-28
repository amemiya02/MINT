import type { ExternalAgentPlatform } from "../ai/external-agent.ts";
import type { SendModelMessage } from "../ai/model.ts";
import type { PrintJob } from "../print/protocol.ts";

/**
 * The platform interface: the only way the shell reaches the outside world
 * (file system, dialogs, window, native menu). Two implementations exist:
 * `tauri.ts` (desktop, via IPC to the Rust backend) and `memory.ts`
 * (tests and the future web build). Shell code must never import Tauri
 * packages directly.
 */
export interface Platform {
  readonly externalAgent: ExternalAgentPlatform;
  readonly sendModelMessage: SendModelMessage;
  listZoteroItems(start: number): Promise<ZoteroPage>;
  /** The user's preferred UI language as a BCP 47 tag, e.g. `zh-CN` or `en-US`. */
  readonly locale: string;
  /** Whether PDF export uses a save dialog and writes the selected file directly. */
  readonly savesPdfDirectly?: boolean;

  /**
   * Read a document as UTF-8 text, exactly as stored: a byte order mark is kept
   * as a leading U+FEFF and line endings are untouched. Rejects if the file is
   * missing or not valid UTF-8.
   */
  readTextFile(path: string): Promise<string>;
  readBinaryFile(path: string): Promise<ArrayBuffer>;

  /** Write text as UTF-8 atomically: either the whole new content lands or the old file stays intact. */
  writeTextFile(path: string, text: string): Promise<void>;

  /** Atomically write the bytes of an exported file to its selected destination. */
  writeBinaryFile(path: string, bytes: Uint8Array): Promise<void>;

  /** App-data snapshots in save order. Their IDs are millisecond timestamps. */
  listVersions(path: string): Promise<number[]>;
  recordVersion(path: string, text: string): Promise<void>;
  readVersion(path: string, id: number): Promise<string>;

  /**
   * Watch one document for changes made on disk: modified, created, deleted or
   * renamed away. `onChange` is called after each (debounced) batch of changes,
   * MINT's own saves included; it is up to the caller to compare contents.
   * Resolves to a function that stops watching.
   */
  watchFile(path: string, onChange: () => void): Promise<() => void>;

  /** Select one import package. The File grants access only to the chosen bytes. */
  pickFile(accept: string): Promise<File | null>;

  /** Ask the user to pick a document. Resolves to its path, or `null` if cancelled. */
  showOpenDialog(options: OpenDialogOptions): Promise<string | null>;

  /**
   * Ask the user where to save a file. `defaultPath` is the suggested file
   * (folder and name). Resolves to the chosen path, or `null` if cancelled.
   */
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>;

  /**
   * Print a standalone HTML document (as HTML export writes it) through the
   * system print dialog, where the user saves it as a PDF. `title` names the
   * print job, and so the suggested PDF file. Resolves once the dialog is up.
   */
  printDocument(html: string, options: Omit<PrintJob, "html">): Promise<void>;

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

  /** Indices of labels with a nonempty match, using the folder search matcher. */
  matchSearchLabels(query: FolderSearchQuery, labels: readonly string[]): Promise<number[]>;

  /**
   * Search the names and text of the files of a folder (the same files `listFolderFiles`
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

  /** Create a regular document with its initial text, or keep an existing regular file intact. */
  ensureDocument(path: string, initialText: string): Promise<void>;

  /** Create a directory. Rejects if anything already exists at `path`. */
  createDirectory(path: string): Promise<void>;

  /** Rename a file or directory. Rejects rather than replace an existing entry. */
  rename(from: string, to: string): Promise<void>;

  /** Install a move or link edit only if the source still matches the preview. */
  applyDocumentEdit(edit: DocumentEdit): Promise<void>;

  /** Move a file or directory to the system trash (never a permanent delete). */
  moveToTrash(path: string): Promise<void>;

  /**
   * Watch a folder recursively. `onChange` receives the paths touched by each
   * batch of changes, MINT's own included, except changes inside `.git` and to
   * entries the folder's `.gitignore` excludes. Resolves to a function that stops watching.
   */
  watchFolder(path: string, onChange: (paths: readonly string[]) => void): Promise<() => void>;

  /**
   * Read a small named file from MINT's app data directory (where MINT keeps
   * its own state, never in a folder the user opened), or `null` if absent.
   */
  readAppData(name: string): Promise<string | null>;

  /** Write a small named file to MINT's app data directory, atomically. */
  writeAppData(name: string, text: string): Promise<void>;

  /**
   * Absolute path of the theme folder (`themes` in the app data directory),
   * created if missing. User themes are the `.css` files in it; read, list and
   * watch it like any folder.
   */
  themesPath(): Promise<string>;

  /** Ask a three-way question (e.g. save / don't save / cancel). Dismissing the dialog answers `cancel`. */
  showQuestionDialog(options: QuestionDialogOptions): Promise<"yes" | "no" | "cancel">;

  /**
   * The text on the system clipboard, e.g. to paste it as plain text. Rejects
   * when the clipboard cannot be read or holds no text.
   */
  readClipboardText(): Promise<string>;
  /** Write plain text to the system clipboard. */
  writeClipboardText(text: string): Promise<void>;

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

  /**
   * Call `listener` with documents and folders handed to MINT from outside the
   * window: double-clicking a document (file association), the command line, or
   * a second launch forwarding its paths. Paths that arrived before the listener
   * was registered are delivered right away. Each path goes to one window only.
   * Returns a function that stops listening.
   */
  onOpenPaths(listener: (paths: readonly OpenedPath[]) => void): () => void;

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

  /**
   * The snapshots left in the recovery area (a directory in the application data
   * directory, never in a working folder) by an earlier run that did not exit
   * cleanly. Only the first call in a run returns them; later calls, e.g. from
   * windows opened afterwards, resolve to an empty list. The snapshots stay in
   * the recovery area until deleted.
   */
  takeRecoverySnapshots(): Promise<RecoverySnapshot[]>;

  /**
   * Create or replace a snapshot in the recovery area, atomically. `id` may only
   * contain ASCII letters, digits, `-` and `_`.
   */
  writeRecoverySnapshot(id: string, contents: string): Promise<void>;

  /** Remove a snapshot from the recovery area; removing one that does not exist is not an error. */
  deleteRecoverySnapshot(id: string): Promise<void>;

  /**
   * Whether this is the first window of the app (the one opened at launch).
   * Once-per-launch work, such as the startup update check, runs only there.
   */
  readonly isMainWindow: boolean;

  /**
   * Ask the release server whether a newer version of MINT exists. Rejects
   * when the check fails (offline, server error).
   */
  checkForUpdate(): Promise<UpdateCheck>;
}

/** One entry of the recovery area. `contents` is opaque to the platform. */
export interface RecoverySnapshot {
  readonly id: string;
  readonly contents: string;
}

export type UpdateCheck =
  /** This build cannot update itself (development build, no updater key, package-manager install). */
  | { readonly status: "unavailable" }
  | { readonly status: "upToDate" }
  | { readonly status: "available"; readonly update: AvailableUpdate };

export interface AvailableUpdate {
  readonly version: string;
  /** Download and install the new version, then restart MINT into it. Rejects if any step fails. */
  install(): Promise<void>;
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

/** A document with a matching file name or matching lines. */
export interface FileMatches {
  readonly nameMatches: boolean;
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

export interface ZoteroItem {
  key: string;
  title: string;
}
export interface ZoteroPage {
  items: ZoteroItem[];
  next: boolean;
}

/** A document or folder to open, handed to MINT from outside the window. */
export interface OpenedPath {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface OpenDialogOptions {
  readonly title: string;
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}

export interface SaveDialogOptions {
  /** Return the known spelling when the chosen file aliases an open document. */
  readonly knownPaths?: readonly string[];
  readonly title: string;
  readonly defaultPath: string;
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

export interface DocumentEdit {
  from: string;
  to: string;
  before: string;
  after: string;
}
