import type { TabStore } from "../tabs/tab-store.ts";
import {
  type SavedTurn,
  type SavedWritingTask,
  type WritingTasksPlatform,
  writeTaskCheckpoint,
} from "./writing-tasks.ts";

const resultPathSubscriptions = new WeakMap<WritingTasksPlatform, Map<string, () => void>>();

export function stopTrackingWritingResult(tasks: WritingTasksPlatform, id: string) {
  resultPathSubscriptions.get(tasks)?.get(id)?.();
}

/** File a standalone result under its document, including when Save As assigns its first path. */
export function recordWritingResult(
  tasks: WritingTasksPlatform,
  store: TabStore,
  {
    tabId,
    id,
    turn,
    origin,
    onError,
  }: {
    readonly tabId: number;
    readonly id: string;
    readonly turn: SavedTurn;
    readonly origin?: SavedWritingTask["origin"];
    readonly onError: () => void;
  },
) {
  const tab = store.getState().tabs.find(({ id }) => id === tabId);
  const editor = store.editor(tabId);
  if (!tab || !editor) return;

  const reading = editor.getSelection();
  const record: SavedWritingTask = {
    version: 1,
    id,
    path: tab.path,
    title: turn.instruction,
    updatedAt: Date.now(),
    baseline: editor.getText(),
    origin: origin ?? { from: reading.head, to: reading.head, located: true, text: "" },
    reading: { ...reading, top: editor.getVisibleRange().from },
    reviewScroll: 0,
    showSource: false,
    turns: [turn],
  };
  const created = writeTaskCheckpoint(tasks, () => tasks.create(record));
  void created.catch(onError);
  if (tab.path !== null) return;

  // The document can be saved and closed before React mounts an effect for the saved path.
  const subscriptions = resultPathSubscriptions.get(tasks) ?? new Map<string, () => void>();
  resultPathSubscriptions.set(tasks, subscriptions);
  const unsubscribe = store.subscribe(() => {
    const current = store.getState().tabs.find(({ documentId }) => documentId === tab.documentId);
    if (current?.path === null) return;
    stopTrackingWritingResult(tasks, id);
    if (!current) return;
    void writeTaskCheckpoint(tasks, async () => {
      await created;
      await tasks.update(
        { ...record, path: current.path, updatedAt: Math.max(record.updatedAt + 1, Date.now()) },
        record.updatedAt,
      );
    }).catch(onError);
  });
  subscriptions.set(id, () => {
    unsubscribe();
    subscriptions.delete(id);
  });
}
