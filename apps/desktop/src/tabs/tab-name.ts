import type { Translate } from "../i18n/index.ts";
import { baseName } from "./paths.ts";
import type { Tab } from "./tab-store.ts";

/** What a tab is called in the tab bar, window title and dialogs: its file name, or Untitled (2, 3, …). */
export function tabName(t: Translate, tab: Pick<Tab, "path" | "untitled">): string {
  if (tab.path !== null) return baseName(tab.path);
  const number = tab.untitled ?? 1;
  return number <= 1 ? t("tabs.untitled") : t("tabs.untitledNumbered", { number: String(number) });
}
