import type { Annotation } from "@mint/editor";
import type { Platform } from "../platform/platform.ts";
import type { Tab, TabStore } from "../tabs/tab-store.ts";

/** Connect each open manuscript, including its second pane, to private app data. */
export function createAnnotationStorage(
  platform: Platform,
  store: TabStore,
  onError: (path: string, error: unknown) => void,
) {
  const pending = new Map<string, Promise<void>>();
  const unsaved = new Map<string, Readonly<Record<string, Annotation>>>();

  function queue(path: string, run: () => Promise<void>) {
    const work = (pending.get(path) ?? Promise.resolve())
      .then(run)
      .catch((error: unknown) => onError(path, error))
      .finally(() => {
        if (pending.get(path) === work) pending.delete(path);
      });
    pending.set(path, work);
  }

  function save(path: string, items: readonly Annotation[]) {
    if (items.length === 0) return;
    const changes = Object.fromEntries(items.map((item) => [item.id, item]));
    queue(path, async () => {
      const next = { ...unsaved.get(path), ...changes };
      unsaved.set(path, next);
      await platform.updateAnnotations(path, next);
      unsaved.delete(path);
    });
  }

  function start() {
    const tracked = new Map<number, ReturnType<typeof track>>();

    function track(tab: Tab) {
      const { annotations } = tab.document;
      let path = tab.path;
      let restoring = false;
      let previous = new Map(annotations.getSnapshot().map((item) => [item.id, item]));
      const unsubscribe = annotations.subscribe(() => {
        const items = annotations.getSnapshot();
        const changes = items.filter((item) => previous.get(item.id) !== item);
        previous = new Map(items.map((item) => [item.id, item]));
        if (path && !restoring) save(path, changes);
      });

      function load(location: string) {
        queue(location, async () => {
          const items = await platform.readAnnotations(location);
          if (tracked.get(tab.documentId) !== binding || path !== location) return;
          const current = store.getState().tabs.find((t) => t.documentId === tab.documentId);
          if (!current) return;
          restoring = true;
          try {
            annotations.restore(Object.values(items), store.getText(current.id) ?? current.text);
          } finally {
            restoring = false;
          }
        });
      }

      const binding = {
        unsubscribe,
        move(next: string | null) {
          if (next === path) return;
          path = next;
          if (!path) return;
          // A first save or Save As gives the open manuscript a new path.
          save(path, annotations.getSnapshot());
          load(path);
        },
      };
      if (path) load(path);
      return binding;
    }

    function sync() {
      const open = new Map(store.getState().tabs.map((tab) => [tab.documentId, tab]));
      for (const [id, binding] of tracked) {
        if (open.has(id)) continue;
        binding.unsubscribe();
        tracked.delete(id);
      }
      for (const [id, tab] of open) {
        const binding = tracked.get(id);
        if (binding) binding.move(tab.path);
        else tracked.set(id, track(tab));
      }
    }

    const unsubscribe = store.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      for (const binding of tracked.values()) binding.unsubscribe();
      tracked.clear();
    };
  }

  async function settled() {
    await Promise.all(pending.values());
    for (const [path, changes] of unsaved) save(path, Object.values(changes));
    await Promise.all(pending.values());
  }

  return { start, settled };
}
