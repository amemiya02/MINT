import type { MintEditor } from "@mint/editor";
import type { Platform } from "../platform/platform.ts";
import { isWithin, rebasePath } from "./paths.ts";

/** One open document in this window. */
export interface Tab {
  readonly id: number;
  readonly path: string;
  /**
   * Text the tab's editor starts from: as read from disk, or unsaved work
   * restored from the recovery area. The editor owns the live text.
   */
  readonly text: string;
  readonly dirty: boolean;
}

export interface TabsState {
  readonly tabs: readonly Tab[];
  readonly activeId: number | null;
  readonly error: TabError | null;
}

export type TabError =
  | { readonly kind: "open"; readonly path: string; readonly reason: string }
  | { readonly kind: "save"; readonly path: string; readonly reason: string };

/** What the user wants to do with unsaved changes when a tab closes. */
export type UnsavedChoice = "save" | "discard" | "cancel";

export interface TabStoreOptions {
  readonly platform: Platform;
  /** Ask the user what to do with a tab that has unsaved changes. */
  readonly askUnsaved: (tab: Tab) => Promise<UnsavedChoice>;
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

  openDocument(path: string): Promise<void>;
  /**
   * Open a tab showing unsaved `text` for the document at `path` (e.g. work
   * recovered after a crash), without reading the file. If the document is
   * already open its tab is focused instead. Returns the tab's id.
   */
  restoreDocument(path: string, text: string): number;
  activate(id: number): void;
  activateNext(): void;
  activatePrevious(): void;
  /** Close a tab, asking first if it has unsaved changes. Resolves to whether it closed. */
  close(id: number): Promise<boolean>;
  /** Close every tab (e.g. before the window closes). Resolves to false if the user cancelled. */
  closeAll(): Promise<boolean>;
  save(id: number): Promise<boolean>;

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
  markChanged(id: number): void;
}

export function createTabStore({ platform, askUnsaved }: TabStoreOptions): TabStore {
  let state: TabsState = { tabs: [], activeId: null, error: null };
  const listeners = new Set<() => void>();
  const editors = new Map<number, MintEditor>();
  /** Bumped on every change, so a save can tell whether edits arrived meanwhile. */
  const versions = new Map<number, number>();
  /** Paths being read, so a double open does not create two tabs. */
  const opening = new Map<string, Promise<void>>();
  let nextId = 1;

  function set(next: Partial<TabsState>) {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  function updateTab(id: number, patch: Partial<Tab>) {
    set({ tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  }

  function step(offset: number) {
    const { tabs, activeId } = state;
    if (tabs.length < 2) return;
    const index = tabs.findIndex((t) => t.id === activeId);
    const target = tabs[(index + offset + tabs.length) % tabs.length];
    if (target) set({ activeId: target.id });
  }

  async function read(path: string) {
    try {
      const text = await platform.readTextFile(path);
      const existing = state.tabs.find((t) => t.path === path);
      if (existing) {
        set({ activeId: existing.id, error: null });
        return;
      }
      const tab: Tab = { id: nextId++, path, text, dirty: false };
      versions.set(tab.id, 0);
      set({ tabs: [...state.tabs, tab], activeId: tab.id, error: null });
    } catch (e) {
      set({ error: { kind: "open", path, reason: reasonOf(e) } });
    }
  }

  const store: TabStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    openDocument(path) {
      const existing = state.tabs.find((t) => t.path === path);
      if (existing) {
        set({ activeId: existing.id });
        return Promise.resolve();
      }
      let pending = opening.get(path);
      if (!pending) {
        pending = read(path).finally(() => opening.delete(path));
        opening.set(path, pending);
      }
      return pending;
    },

    restoreDocument(path, text) {
      const existing = state.tabs.find((t) => t.path === path);
      if (existing) {
        set({ activeId: existing.id });
        return existing.id;
      }
      const tab: Tab = { id: nextId++, path, text, dirty: true };
      versions.set(tab.id, 0);
      set({ tabs: [...state.tabs, tab], activeId: tab.id });
      return tab.id;
    },

    activate(id) {
      if (state.tabs.some((t) => t.id === id)) set({ activeId: id });
    },
    activateNext: () => step(1),
    activatePrevious: () => step(-1),

    async close(id) {
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) return true;
      if (tab.dirty) {
        set({ activeId: id });
        const choice = await askUnsaved(tab);
        if (choice === "cancel") return false;
        if (choice === "save" && !(await store.save(id))) return false;
      }
      const index = state.tabs.findIndex((t) => t.id === id);
      const tabs = state.tabs.filter((t) => t.id !== id);
      let { activeId } = state;
      if (activeId === id) activeId = (tabs[index] ?? tabs[index - 1])?.id ?? null;
      editors.delete(id);
      versions.delete(id);
      set({ tabs, activeId });
      return true;
    },

    async closeAll() {
      for (const tab of [...state.tabs]) {
        if (!(await store.close(tab.id))) return false;
      }
      return true;
    },

    async save(id) {
      const tab = state.tabs.find((t) => t.id === id);
      const editor = editors.get(id);
      if (!tab || !editor) return false;
      const savedVersion = versions.get(id);
      try {
        await platform.writeTextFile(tab.path, editor.getText());
        updateTab(id, { dirty: versions.get(id) !== savedVersion });
        set({ error: null });
        return true;
      } catch (e) {
        set({ error: { kind: "save", path: tab.path, reason: reasonOf(e) } });
        return false;
      }
    },

    pathRenamed(from, to) {
      set({ tabs: state.tabs.map((t) => ({ ...t, path: rebasePath(t.path, from, to) })) });
    },

    pathTrashed(path) {
      for (const tab of state.tabs) {
        if (isWithin(tab.path, path) && !tab.dirty) void store.close(tab.id);
      }
    },
    editor: (id) => editors.get(id) ?? null,

    attachEditor(id, editor) {
      if (editor) editors.set(id, editor);
      else editors.delete(id);
    },

    markChanged(id) {
      versions.set(id, (versions.get(id) ?? 0) + 1);
      if (!state.tabs.find((t) => t.id === id)?.dirty) updateTab(id, { dirty: true });
    },
  };
  return store;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
