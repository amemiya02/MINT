import { createContext, useContext, useSyncExternalStore } from "react";
import type { ThemeState, ThemeStore } from "./theme.ts";

export const ThemeContext = createContext<ThemeStore | null>(null);

/** The theme folder, the user themes in it, and why the chosen one is not in use; re-renders when they change. */
export function useTheme(): ThemeState {
  const store = useContext(ThemeContext);
  if (!store) throw new Error("useTheme needs a <ThemeContext> provider");
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
