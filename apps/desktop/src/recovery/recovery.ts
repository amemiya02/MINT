import type { Platform, RecoverySnapshot } from "../platform/platform.ts";
import type { TabStore } from "../tabs/tab-store.ts";

/** How often, at most, the unsaved text of an edited document is copied to the recovery area. */
export const snapshotIntervalMs = 2000;

/** What the user wants done with unsaved work found after a crash. */
export type RecoveryChoice = "restore" | "discard" | "later";

export interface RecoveryOptions {
  readonly platform: Platform;
  readonly store: TabStore;
  readonly intervalMs?: number;
}

/**
 * Crash recovery for one window. While a document has unsaved changes, its text
 * is copied every few seconds to the recovery area (in the application data
 * directory, never in a working folder); the copy is removed once the document
 * is saved or its tab is closed. Whatever is left there at the next start was
 * not saved, and `offerRestore` offers to bring it back.
 */
export interface Recovery {
  /** Start following the window's tabs. Returns a function that stops. */
  start(): () => void;
  /** Tell recovery that the user edited a tab. */
  edited(id: number): void;
  /**
   * Look for unsaved work left by an earlier run and, if there is any, ask what
   * to do with it. Restored documents open as tabs with unsaved changes.
   */
  offerRestore(
    ask: (documents: readonly (string | null)[]) => Promise<RecoveryChoice>,
  ): Promise<void>;
  /** Resolves once every snapshot write and removal so far has reached the platform. */
  settled(): Promise<void>;
}

/** The contents of a snapshot file. */
interface Snapshot {
  readonly version: 1;
  /** Path of the document the text belongs to; `null` for an untitled document. */
  readonly path: string | null;
  /** The document's full unsaved text. */
  readonly text: string;
  /** When the snapshot was taken (ms since the epoch). */
  readonly takenAt: number;
}

export function createRecovery({
  platform,
  store,
  intervalMs = snapshotIntervalMs,
}: RecoveryOptions): Recovery {
  // Snapshot ids must not clash with other windows' or earlier runs'.
  const session = crypto.randomUUID();
  const snapshotId = (tabId: number) => `${session}-${tabId}`;
  /** Tabs edited since the last snapshot round. */
  const pending = new Set<number>();
  /** Tabs that currently have a snapshot in the recovery area. */
  const written = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Platform calls run one after another, so a removal never overtakes a write.
  let queue = Promise.resolve();

  function enqueue(operation: () => Promise<void>) {
    queue = queue.then(operation).catch((e: unknown) => {
      console.warn("MINT: recovery area update failed", e);
    });
  }

  function writeSnapshot(id: number) {
    const tab = store.getState().tabs.find((t) => t.documentId === id);
    if (!tab?.dirty) return;
    const snapshot: Snapshot = {
      version: 1,
      path: tab.path,
      // Before its editor mounts, a tab's text is the text it starts from.
      text: store.getText(tab.id) ?? tab.text,
      takenAt: Date.now(),
    };
    written.add(id);
    enqueue(() => platform.writeRecoverySnapshot(snapshotId(id), JSON.stringify(snapshot)));
  }

  function takeSnapshots() {
    timer = null;
    for (const id of pending) writeSnapshot(id);
    pending.clear();
  }

  /** Remove the snapshots of tabs that were saved or closed. */
  function tabsChanged() {
    const { tabs } = store.getState();
    for (const id of written) {
      if (tabs.find((t) => t.documentId === id)?.dirty) continue;
      written.delete(id);
      enqueue(() => platform.deleteRecoverySnapshot(snapshotId(id)));
    }
  }

  return {
    start() {
      const unsubscribe = store.subscribe(tabsChanged);
      return () => {
        unsubscribe();
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };
    },

    edited(id) {
      pending.add(id);
      timer ??= setTimeout(takeSnapshots, intervalMs);
    },

    async offerRestore(ask) {
      const found: { id: string; snapshot: Snapshot }[] = [];
      for (const entry of await platform.takeRecoverySnapshots()) {
        const snapshot = parse(entry);
        if (snapshot) found.push({ id: entry.id, snapshot });
        // Unusable leftovers would otherwise be offered again on every start.
        else enqueue(() => platform.deleteRecoverySnapshot(entry.id));
      }
      if (found.length === 0) return;

      // If several windows had the same document open, the newest text wins. Untitled documents are all distinct.
      const latest = new Map<string, Snapshot>();
      for (const { id, snapshot } of found.sort(
        (a, b) => a.snapshot.takenAt - b.snapshot.takenAt,
      )) {
        latest.set(snapshot.path ?? `untitled:${id}`, snapshot);
      }

      const choice = await ask([...latest.values()].map((snapshot) => snapshot.path));
      if (choice === "later") return;
      if (choice === "restore") {
        for (const { path, text } of latest.values()) {
          // Copied under this window's id first, so the work is never out of the recovery area.
          writeSnapshot(store.restoreDocument(path, text));
        }
      }
      for (const { id } of found) enqueue(() => platform.deleteRecoverySnapshot(id));
      await queue;
    },

    settled: () => queue,
  };
}

function parse(entry: RecoverySnapshot): Snapshot | null {
  try {
    const value: unknown = JSON.parse(entry.contents);
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "path" in value &&
      (typeof value.path === "string" || value.path === null) &&
      "text" in value &&
      typeof value.text === "string" &&
      "takenAt" in value &&
      typeof value.takenAt === "number"
    ) {
      return value as Snapshot;
    }
  } catch {
    // Not JSON: treated like any other unusable snapshot.
  }
  return null;
}
