import { createContext, useContext, useSyncExternalStore } from "react";
import type { TabStore, TabsState } from "./tab-store.ts";

export const TabStoreContext = createContext<TabStore | null>(null);

/**
 * The window's tab store. Anything that shows a document (menus, the file
 * tree, links) calls `useTabStore().openDocument(path)`.
 */
export function useTabStore(): TabStore {
  const store = useContext(TabStoreContext);
  if (!store) throw new Error("useTabStore must be used inside <TabStoreContext>");
  return store;
}

export function useTabsState(): TabsState {
  const store = useTabStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
