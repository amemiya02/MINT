import { type MintEditor, SharedDocument } from "@mint/editor";
import { matchingHeadings } from "@mint/markdown";
import { isWithin, rebasePath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";

export type Pane = "primary" | "reference";

/** One open document in this window. */
export interface Tab {
  readonly id: number;
  readonly documentId: number;
  readonly document: SharedDocument;
  readonly pane: Pane;
  /** Where the document is saved; `null` for an untitled document that has not been saved yet. */
  readonly path: string | null;
  /** An untitled document's number in this window (Untitled, Untitled 2, …); `null` once it has a path. */
  readonly untitled: number | null;
  /**
   * Text the tab's editor starts from: as read from disk, or unsaved work
   * restored from the recovery area. The editor owns the live text.
   */
  readonly text: string;
  readonly dirty: boolean;
  /** A change made to the document on disk by another program that the user has to know about. */
  readonly external: ExternalChange | null;
}

export type ExternalChange =
  /** The document changed on disk while the tab had unsaved changes. */
  | { readonly kind: "conflict"; readonly diskText: string }
  /** The document was deleted or renamed away. */
  | { readonly kind: "missing" };

/** How the user settles a conflict between the tab and the document on disk. */
export type ConflictChoice = "keepMine" | "loadDisk";
/** A range within one line of a document, e.g. a global search match. */
export interface LineRange {
  /** Original line text when navigating from a search result on disk. */
  readonly text?: string;
  /** 1-based line number; lines end at a line feed. */
  readonly line: number;
  /** `[from, to)` as UTF-16 offsets into the line. */
  readonly from: number;
  readonly to: number;
}

/** A folder text hit can move while the open draft is edited. Prefer its reported line,
 * then accept a unique occurrence of the same line in the draft. */
function startOfMatch(text: string, range: LineRange): number | null {
  let start = 0;
  let matches = 0;
  let candidate = 0;
  for (const [index, line] of text.split("\n").entries()) {
    if (range.text === undefined || line.replace(/\r+$/, "") === range.text) {
      if (index + 1 === range.line) return start;
      candidate = start;
      matches++;
    }
    start += line.length + 1;
  }
  return matches === 1 || range.text === undefined ? candidate : null;
}

type DocumentLocation = LineRange | { readonly fragment: string };

export interface TabsState {
  readonly tabs: readonly Tab[];
  readonly activeId: number | null;
  readonly selected: Readonly<Record<Pane, number | null>>;
  readonly error: TabError | null;
}

export type TabError =
  | { readonly kind: "staleSearchResult" }
  | { readonly kind: "missingHeading" | "ambiguousHeading"; readonly fragment: string }
  | { readonly kind: "open"; readonly path: string; readonly reason: string }
  | { readonly kind: "save" | "history"; readonly path: string; readonly reason: string }
  /** The document cannot be watched: changes other programs make to it go unnoticed. */
  | { readonly kind: "watch"; readonly path: string; readonly reason: string };

/** What the user wants to do with unsaved changes when a tab closes. */
export type UnsavedChoice = "save" | "discard" | "cancel";

export interface TabStoreOptions {
  readonly platform: Platform;
  /** Ask the user what to do with a tab that has unsaved changes. */
  readonly askUnsaved: (tab: Tab) => Promise<UnsavedChoice>;
  /** Ask the user where to save a tab's document (Save As, or the first save of an untitled one); `null` if cancelled. */
  readonly askSavePath: (tab: Tab) => Promise<string | null>;
}

/**
 * The tabs of one window and the documents they hold. Framework-agnostic so
 * any part of the shell (menu commands, the file tree, links) can drive it;
 * React subscribes through `subscribe`/`getState`.
 *
 * `openDocument(path)` is the single entry point for showing a document: it
 * focuses the tab if the document is already open, otherwise reads the file
 * and opens a new tab.
 */
export interface TabStore {
  getState(): TabsState;
  subscribe(listener: () => void): () => void;

  /** Once the document shows, select a line range or move to a linked heading. */
  openDocument(path: string, select?: DocumentLocation): Promise<void>;
  /** Follow an anchor in the currently open tab, including an untitled document. */
  revealHeading(id: number, fragment: string): void;
  /** Open a tab with a new, empty, untitled document. Returns the tab's id. */
  newDocument(): number;
  /**
   * Open a tab showing unsaved `text` for the document at `path` (e.g. work
   * recovered after a crash), without reading the file; `null` restores an
   * untitled document. If the document is already open its tab is focused
   * instead. Returns the tab's id.
   */
  restoreDocument(path: string | null, text: string): number;
  activate(id: number): void;
  openInOtherPane(id: number): void;
  focusOtherPane(): void;
  closeReferencePane(): void;
  activateNext(): void;
  activatePrevious(): void;
  /** Close a tab, asking first if it has unsaved changes. Resolves to whether it closed. */
  close(id: number): Promise<boolean>;
  /** Close every tab (e.g. before the window closes). Resolves to false if the user cancelled. */
  closeAll(): Promise<boolean>;
  /** Save the tab's document; an untitled one asks where first. Resolves to whether it was saved. */
  save(id: number): Promise<boolean>;
  /** Ask where to save the tab's document, save it there, and let the tab follow it. */
  saveAs(id: number): Promise<boolean>;
  /** The tab's live text, or `null` if its editor is not mounted. */
  getText(id: number): string | null;
  /** Settle a conflict with the document on disk. */
  resolveConflict(id: number, choice: ConflictChoice): void;
  /** Hide the notice about a document that was deleted or moved (the tab stays unsaved). */
  dismissExternal(id: number): void;

  /** A file or directory was renamed: tabs of documents at or under `from` follow it to `to`. */
  pathRenamed(from: string, to: string): void;
  /**
   * A file or directory was moved to the trash: tabs of documents at or under
   * it close, except those with unsaved changes (saving them restores the file).
   */
  pathTrashed(path: string): void;

  /** The editor of a tab, once its view has mounted. */
  editor(id: number): MintEditor | null;
  /** Called by a tab's editor view as it mounts (`editor`) and unmounts (`null`). */
  attachEditor(id: number, editor: MintEditor | null): void;
  /** Called by a tab's editor view on every text change. */
  markChanged(id: number, fromHistory?: boolean): void;
}

export function createTabStore({ platform, askUnsaved, askSavePath }: TabStoreOptions): TabStore {
  let state: TabsState = {
    tabs: [],
    activeId: null,
    selected: { primary: null, reference: null },
    error: null,
  };
  const listeners = new Set<() => void>();
  const editors = new Map<number, MintEditor>();
  /** Bumped on every change, so a save can tell whether edits arrived meanwhile. */
  const versions = new Map<number, number>();
  /** Version at the last load or save: the tab has edits of its own when its version differs. */
  const cleanVersions = new Map<number, number>();
  /** The text the document had on disk when MINT last read or wrote it. */
  const diskTexts = new Map<number, string>();
  /** Bumped when a save starts, so a disk check that overlaps a save is discarded. */
  const saveEpochs = new Map<number, number>();
  /** Tail of each tab’s save queue, including any outstanding Save As dialog. */
  const savesInFlight = new Map<number, Promise<boolean>>();
  /** Tabs whose document changed while they were saving: check again afterwards. */
  const recheck = new Set<number>();
  const unwatchers = new Map<number, Promise<() => void>>();
  /** Set while the store itself replaces a tab's text, so the change does not count as an edit. */
  let reloading: number | null = null;
  /** Paths being read, so a double open does not create two tabs. */
  const opening = new Map<string, Promise<void>>();
  /** Ranges to select in tabs whose editor has not mounted yet. */
  const pendingSelections = new Map<number, DocumentLocation>();
  let nextId = 1;
  /** Numbers untitled documents of this window (Untitled, Untitled 2, …). */
  let nextUntitled = 1;

  function set(next: Partial<TabsState>) {
    let tabs = next.tabs ?? state.tabs;
    if (tabs.length && !tabs.some((tab) => tab.pane === "primary")) {
      tabs = tabs.map((tab) => ({ ...tab, pane: "primary" }));
    }
    const activeId = next.activeId === undefined ? state.activeId : next.activeId;
    const selected = { ...(next.selected ?? state.selected) };
    for (const pane of ["primary", "reference"] as const) {
      const members = tabs.filter((tab) => tab.pane === pane);
      selected[pane] =
        members.find((tab) => tab.id === activeId)?.id ??
        members.find((tab) => tab.id === selected[pane])?.id ??
        members.at(-1)?.id ??
        null;
    }
    state = { ...state, ...next, tabs, selected };
    for (const listener of listeners) listener();
  }

  function documentTab(id: number) {
    return state.tabs.find((t) => t.documentId === id);
  }

  function documentEditor(id: number) {
    const tab = state.tabs.find((t) => t.documentId === id && editors.has(t.id));
    return tab ? editors.get(tab.id) : undefined;
  }

  function documentId(id: number) {
    return state.tabs.find((t) => t.id === id)?.documentId ?? id;
  }

  function updateTab(id: number, patch: Partial<Tab>) {
    set({ tabs: state.tabs.map((t) => (t.documentId === id ? { ...t, ...patch } : t)) });
  }

  function activePane(): Pane {
    return state.tabs.find((tab) => tab.id === state.activeId)?.pane ?? "primary";
  }

  function step(offset: number) {
    const { activeId } = state;
    const tabs = state.tabs.filter((tab) => tab.pane === activePane());
    if (tabs.length < 2) return;
    const index = tabs.findIndex((t) => t.id === activeId);
    const target = tabs[(index + offset + tabs.length) % tabs.length];
    if (target) set({ activeId: target.id });
  }

  function reveal(id: number, editor: MintEditor, range: DocumentLocation) {
    if (state.activeId !== id || editors.get(id) !== editor) return;
    if ("fragment" in range) {
      const matches = matchingHeadings(editor.getOutline(), range.fragment);
      const heading = matches[0];
      if (!heading || matches.length > 1) {
        set({
          error: {
            kind: heading ? "ambiguousHeading" : "missingHeading",
            fragment: range.fragment,
          },
        });
        return;
      }
      editor.setSelection({ anchor: heading.from, scrollIntoView: "start" });
      editor.focus();
      return;
    }
    const text = editor.getText();
    const start = startOfMatch(text, range);
    if (start === null) {
      set({ error: { kind: "staleSearchResult" } });
      return;
    }
    const clamp = (offset: number) => Math.min(start + offset, text.length);
    editor.setSelection({
      anchor: clamp(range.from),
      head: clamp(range.to),
      scrollIntoView: true,
    });
    editor.focus();
  }

  async function read(path: string) {
    try {
      const text = await platform.readTextFile(path);
      const existing = state.tabs.find((t) => t.path === path);
      if (existing) {
        set({ activeId: existing.id, error: null });
        return;
      }
      const tab: Tab = {
        documentId: nextId,
        document: new SharedDocument(),
        id: nextId++,
        pane: activePane(),
        path,
        untitled: null,
        text,
        dirty: false,
        external: null,
      };
      versions.set(tab.id, 0);
      cleanVersions.set(tab.id, 0);
      diskTexts.set(tab.id, text);
      saveEpochs.set(tab.id, 0);
      watch(tab.id, path);
      set({ tabs: [...state.tabs, tab], activeId: tab.id, error: null });
    } catch (e) {
      set({ error: { kind: "open", path, reason: reasonOf(e) } });
    }
  }

  /** Watch the tab's document for changes by other programs (replacing any earlier watch). */
  function watch(id: number, path: string) {
    unwatch(id);
    unwatchers.set(
      id,
      platform
        .watchFile(path, () => void checkDisk(id))
        .catch((e: unknown) => {
          // The tab still works, but the user must know changes on disk go unnoticed.
          set({ error: { kind: "watch", path, reason: reasonOf(e) } });
          return () => {};
        }),
    );
  }

  function unwatch(id: number) {
    const stop = unwatchers.get(id);
    unwatchers.delete(id);
    void stop?.then((f) => f());
  }

  function hasOwnEdits(id: number) {
    return versions.get(id) !== cleanVersions.get(id);
  }

  function markClean(id: number, diskText: string) {
    diskTexts.set(id, diskText);
    cleanVersions.set(id, versions.get(id) ?? 0);
    updateTab(id, { dirty: false, external: null });
  }

  /** Put the disk text into the tab's editor; the selection stays near the text around it. */
  function loadDiskText(id: number, diskText: string) {
    const editor = documentEditor(id);
    if (!editor) return;
    if (editor.getText() !== diskText) {
      reloading = id;
      try {
        editor.replaceText(diskText);
      } finally {
        reloading = null;
      }
    }
    markClean(id, diskText);
  }

  /** React to a watcher event: compare the document on disk with what the tab knows. */
  async function checkDisk(id: number) {
    if (savesInFlight.has(id)) {
      recheck.add(id);
      return;
    }
    const tab = documentTab(id);
    if (!tab || tab.path === null) return;
    const epoch = saveEpochs.get(id);
    let diskText: string | null;
    try {
      diskText = await platform.readTextFile(tab.path);
    } catch {
      diskText = null;
    }
    const current = documentTab(id);
    if (!current || current.path !== tab.path) return;
    if (saveEpochs.get(id) !== epoch || savesInFlight.has(id)) {
      // A save overlapped the read: what was read may already be stale.
      recheck.add(id);
      if (!savesInFlight.has(id)) void runRecheck(id);
      return;
    }

    if (diskText === null) {
      if (current.external?.kind !== "missing") {
        // Closing the tab now would lose the text, so it counts as unsaved.
        updateTab(id, { dirty: true, external: { kind: "missing" } });
      }
      return;
    }
    // MINT's own save, or a change that left the content as it was.
    if (diskText === diskTexts.get(id) && current.external?.kind !== "missing") return;

    if (!hasOwnEdits(id)) {
      loadDiskText(id, diskText);
    } else if (documentEditor(id)?.getText() === diskText) {
      markClean(id, diskText);
    } else {
      updateTab(id, { external: { kind: "conflict", diskText } });
    }
  }

  /** Snapshot this request now. A queued Save follows the path established by the preceding Save As. */
  function save(id: number, choosePath: boolean): Promise<boolean> {
    const editor = documentEditor(id);
    if (!editor) return Promise.resolve(false);
    const text = editor.getText();
    const version = versions.get(id) ?? 0;

    async function write() {
      const tab = documentTab(id);
      if (!tab) return false;
      const path = choosePath || tab.path === null ? await askSavePath(tab) : tab.path;
      if (path === null || !versions.has(id)) return false;
      try {
        await platform.writeTextFile(path, text);
        let historyError: TabError | null = null;
        try {
          await platform.recordVersion(path, text);
        } catch (e) {
          historyError = { kind: "history", path, reason: reasonOf(e) };
        }
        if (!versions.has(id)) return true;
        diskTexts.set(id, text);
        cleanVersions.set(id, version);
        const moved = path !== tab.path;
        updateTab(id, {
          dirty: versions.get(id) !== version,
          external: null,
          ...(moved ? { path, untitled: null } : {}),
        });
        if (moved) watch(id, path);
        set({ error: historyError });
        return true;
      } catch (e) {
        if (versions.has(id)) set({ error: { kind: "save", path, reason: reasonOf(e) } });
        return false;
      }
    }

    saveEpochs.set(id, (saveEpochs.get(id) ?? 0) + 1);
    const previous = savesInFlight.get(id) ?? Promise.resolve();
    const pending = previous.then(write, write).finally(() => {
      if (savesInFlight.get(id) !== pending) return;
      savesInFlight.delete(id);
      void runRecheck(id);
    });
    savesInFlight.set(id, pending);
    return pending;
  }

  async function runRecheck(id: number) {
    if (!recheck.delete(id)) return;
    await checkDisk(id);
  }

  const store: TabStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async openDocument(path, select) {
      const existing = state.tabs.find((t) => t.path === path);
      if (existing) {
        set({ activeId: existing.id, error: null });
      } else {
        let pending = opening.get(path);
        if (!pending) {
          pending = read(path).finally(() => opening.delete(path));
          opening.set(path, pending);
        }
        await pending;
      }
      const tab = state.tabs.find((t) => t.path === path);
      if (!select || !tab) return;
      const editor = editors.get(tab.id);
      // Opening a tab may still need React to show its panel before scrolling.
      if (editor) setTimeout(() => reveal(tab.id, editor, select));
      else pendingSelections.set(tab.id, select);
    },

    revealHeading(id, fragment) {
      const editor = editors.get(id);
      if (editor) {
        set({ error: null });
        reveal(id, editor, { fragment });
      }
    },

    newDocument() {
      const tab: Tab = {
        documentId: nextId,
        document: new SharedDocument(),
        id: nextId++,
        pane: activePane(),
        path: null,
        untitled: nextUntitled++,
        text: "",
        dirty: false,
        external: null,
      };
      versions.set(tab.id, 0);
      cleanVersions.set(tab.id, 0);
      saveEpochs.set(tab.id, 0);
      set({ tabs: [...state.tabs, tab], activeId: tab.id });
      return tab.id;
    },

    restoreDocument(path, text) {
      const existing = path === null ? undefined : state.tabs.find((t) => t.path === path);
      if (existing) {
        set({ activeId: existing.id });
        return existing.id;
      }
      const untitled = path === null ? nextUntitled++ : null;
      const tab: Tab = {
        documentId: nextId,
        document: new SharedDocument(),
        id: nextId++,
        pane: activePane(),
        path,
        untitled,
        text,
        dirty: true,
        external: null,
      };
      // Unsaved work: the tab has edits of its own, so a change on disk is a conflict.
      versions.set(tab.id, 0);
      cleanVersions.set(tab.id, -1);
      saveEpochs.set(tab.id, 0);
      set({ tabs: [...state.tabs, tab], activeId: tab.id });
      if (path === null) return tab.id;
      watch(tab.id, path);
      // What the disk holds now is the baseline, so only later changes count as external.
      const { id } = tab;
      void platform
        .readTextFile(path)
        .then((diskText) => {
          if (!diskTexts.has(id) && documentTab(id)) diskTexts.set(id, diskText);
        })
        .catch((e: unknown) => {
          // Without a baseline, the next change on disk is compared with nothing and reported as a conflict.
          console.warn(`MINT: cannot read ${path} to compare it with the restored text`, e);
        });
      return tab.id;
    },

    activate(id) {
      if (state.tabs.some((t) => t.id === id)) set({ activeId: id });
    },
    openInOtherPane(id) {
      const tab = state.tabs.find((item) => item.id === id);
      if (!tab) return;
      const pane = tab.pane === "primary" ? "reference" : "primary";
      const other = state.tabs.find(
        (item) => item.documentId === tab.documentId && item.pane === pane,
      );
      if (other) {
        store.activate(other.id);
        editors.get(other.id)?.focus();
        return;
      }
      const view: Tab = {
        ...tab,
        id: nextId++,
        pane,
      };
      const neighbour = state.tabs.findLast((item) => item.pane === tab.pane && item.id !== id);
      set({
        tabs: [...state.tabs, view],
        activeId: view.id,
        selected: { ...state.selected, [tab.pane]: neighbour?.id ?? id },
      });
    },
    focusOtherPane() {
      const id = state.selected[activePane() === "primary" ? "reference" : "primary"];
      if (id !== null) {
        store.activate(id);
        editors.get(id)?.focus();
      }
    },
    closeReferencePane() {
      const id = state.selected.primary;
      if (id === null || state.selected.reference === null) return;
      const primary = new Set(
        state.tabs.filter((t) => t.pane === "primary").map((t) => t.documentId),
      );
      const tabs = state.tabs.filter((t) => t.pane === "primary" || !primary.has(t.documentId));
      set({ tabs: tabs.map((tab) => ({ ...tab, pane: "primary" })), activeId: id });
      editors.get(id)?.focus();
    },
    activateNext: () => step(1),
    activatePrevious: () => step(-1),

    async close(id) {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return true;
      const lastView = !state.tabs.some((t) => t.id !== id && t.documentId === tab.documentId);
      if (lastView && tab.dirty) {
        set({ activeId: id });
        const choice = await askUnsaved(tab);
        if (choice === "cancel") return false;
        if (choice === "save") {
          if (!(await store.save(id))) return false;
          // Edits made while writing still need a decision before this tab can close.
          if (state.tabs.find((t) => t.id === id)?.dirty) return false;
        }
      }
      const index = state.tabs.findIndex((t) => t.id === id);
      const tabs = state.tabs.filter((t) => t.id !== id);
      let { activeId } = state;
      if (activeId === id) {
        const neighbours = [...tabs.slice(index), ...tabs.slice(0, index).reverse()];
        activeId =
          neighbours.find((item) => item.pane === tab.pane)?.id ??
          state.selected[tab.pane === "primary" ? "reference" : "primary"];
      }
      editors.delete(id);
      if (lastView) {
        versions.delete(tab.documentId);
        cleanVersions.delete(tab.documentId);
        diskTexts.delete(tab.documentId);
        saveEpochs.delete(tab.documentId);
        recheck.delete(tab.documentId);
        unwatch(tab.documentId);
      }
      pendingSelections.delete(id);
      set({ tabs, activeId });
      return true;
    },

    async closeAll() {
      for (const tab of [...state.tabs]) {
        if (!(await store.close(tab.id))) return false;
      }
      return true;
    },

    save: (id) => save(documentId(id), false),
    saveAs: (id) => save(documentId(id), true),

    getText: (id) => documentEditor(documentId(id))?.getText() ?? null,

    resolveConflict(id, choice) {
      const tab = state.tabs.find((t) => t.id === id);
      if (tab?.external?.kind !== "conflict") return;
      const { diskText } = tab.external;
      if (choice === "loadDisk") {
        loadDiskText(tab.documentId, diskText);
      } else {
        // The next save overwrites the disk; until then this disk text is known.
        diskTexts.set(tab.documentId, diskText);
        updateTab(tab.documentId, { external: null });
      }
    },

    dismissExternal(id) {
      updateTab(documentId(id), { external: null });
    },

    pathRenamed(from, to) {
      const before = state.tabs;
      set({
        tabs: state.tabs.map((t) =>
          t.path === null ? t : { ...t, path: rebasePath(t.path, from, to) },
        ),
      });
      for (const tab of new Map(state.tabs.map((t) => [t.documentId, t])).values()) {
        if (tab.path !== null && before.find((t) => t.id === tab.id)?.path !== tab.path) {
          watch(tab.documentId, tab.path);
        }
      }
    },

    pathTrashed(path) {
      for (const tab of state.tabs) {
        if (tab.path !== null && isWithin(tab.path, path) && !tab.dirty) void store.close(tab.id);
      }
    },
    editor: (id) => editors.get(id) ?? null,

    attachEditor(id, editor) {
      if (!editor) {
        editors.delete(id);
        return;
      }
      editors.set(id, editor);
      const select = pendingSelections.get(id);
      pendingSelections.delete(id);
      if (select) setTimeout(() => reveal(id, editor, select));
    },

    markChanged(viewId, fromHistory = false) {
      const id = documentId(viewId);
      if (reloading === id) return;
      versions.set(id, (versions.get(id) ?? 0) + 1);
      const tab = documentTab(id);
      const clean =
        fromHistory &&
        diskTexts.has(id) &&
        tab?.external?.kind !== "missing" &&
        editors.get(viewId)?.getText() === diskTexts.get(id);
      if (clean) cleanVersions.set(id, versions.get(id) ?? 0);
      if (tab && tab.dirty === clean) updateTab(id, { dirty: !clean });
    },
  };
  return store;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
