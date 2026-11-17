import type { TabStore } from "../tabs/tab-store.ts";

/** How long typing must pause before a document is saved automatically. */
export const autosaveDelayMs = 1000;

export interface AutosaveOptions {
  readonly store: TabStore;
  /** Whether autosave is on right now (the `autosave` setting); read each time a save is due. */
  readonly isEnabled: () => boolean;
  readonly delayMs?: number;
}

/**
 * Saves a document once typing in it has paused for about a second. Saving goes
 * through the tab store's normal save, so it behaves exactly like the save command.
 */
export interface Autosave {
  /** Tell autosave that the user edited a tab; restarts that tab's countdown. */
  edited(id: number): void;
  /** Cancel every pending save. */
  dispose(): void;
}

export function createAutosave({
  store,
  isEnabled,
  delayMs = autosaveDelayMs,
}: AutosaveOptions): Autosave {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function cancel(id: number) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }

  return {
    edited(id) {
      cancel(id);
      if (!isEnabled()) return;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          const tab = store.getState().tabs.find((t) => t.id === id);
          // A notice about a change on disk must be settled by the user, never overwritten.
          // An untitled document waits for the user to give it a place: autosave never asks.
          if (tab?.dirty && !tab.external && tab.path !== null && isEnabled()) void store.save(id);
        }, delayMs),
      );
    },
    dispose() {
      for (const id of [...timers.keys()]) cancel(id);
    },
  };
}
