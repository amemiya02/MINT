import { useT } from "../i18n/index.ts";
import { useTabStore, useTabsState } from "./context.ts";
import { tabName } from "./tab-name.ts";

import type { Pane } from "./tab-store.ts";

/** The row of tabs above the editor: one per open document in this window. */
export function TabBar({ pane }: { readonly pane: Pane }) {
  const t = useT();
  const store = useTabStore();
  const { tabs, selected } = useTabsState();

  async function close(id: number) {
    if (!(await store.close(id))) return;
    const { activeId } = store.getState();
    if (activeId !== null) store.editor(activeId)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={t("tabs.label")}
      className="flex min-h-9 overflow-x-auto border-b border-(--mint-border) text-sm"
    >
      {tabs
        .filter((tab) => tab.pane === pane)
        .map((tab) => {
          const name = tabName(t, tab);
          const active = tab.id === selected[pane];
          return (
            <div
              key={tab.id}
              className={`group flex shrink-0 items-center border-r border-(--mint-border) ${
                active ? "bg-(--mint-bg) text-(--mint-fg)" : "bg-(--mint-hover) text-(--mint-muted)"
              }`}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={active}
                aria-controls={`tabpanel-${tab.id}`}
                title={tab.path ?? undefined}
                onClick={() => {
                  store.activate(tab.id);
                  store.editor(tab.id)?.focus();
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) void close(tab.id);
                }}
                className="max-w-56 truncate py-1.5 pl-3 pr-1 focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
              >
                {name}
              </button>
              <span className="w-3 text-center text-(--mint-accent)" aria-hidden={!tab.dirty}>
                {tab.dirty && <span title={t("status.unsaved")}>●</span>}
              </span>

              <button
                type="button"
                aria-label={t("tabs.otherPane", { name })}
                title={t("tabs.otherPane", { name })}
                onClick={() => store.openInOtherPane(tab.id)}
                className="px-1 text-(--mint-muted) hover:bg-(--mint-border)"
              >
                ⇄
              </button>
              <button
                type="button"
                aria-label={t("tabs.close", { name })}
                onClick={() => void close(tab.id)}
                className="mx-1 rounded px-1 leading-none text-(--mint-muted) hover:bg-(--mint-border) hover:text-(--mint-fg) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
              >
                ×
              </button>
            </div>
          );
        })}
      {pane === "reference" && (
        <button
          type="button"
          aria-label={t("command.view.closeReferencePane")}
          title={t("command.view.closeReferencePane")}
          onClick={() => store.closeReferencePane()}
          className="ml-auto px-2"
        >
          ⊟
        </button>
      )}
    </div>
  );
}
