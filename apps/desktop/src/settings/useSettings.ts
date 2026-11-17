import { createContext, useContext, useSyncExternalStore } from "react";
import type { SettingsState, SettingsStore } from "./settings.ts";

export const SettingsContext = createContext<SettingsStore | null>(null);

/** The settings store, for changing settings. */
export function useSettingsStore(): SettingsStore {
  const store = useContext(SettingsContext);
  if (!store) throw new Error("useSettings needs a <SettingsContext> provider");
  return store;
}

/** The current settings (and problems with settings.json); re-renders when they change. */
export function useSettings(): SettingsState {
  const store = useSettingsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
