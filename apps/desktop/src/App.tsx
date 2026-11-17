import { useCallback, useEffect, useRef, useState } from "react";
import { buildMenu, type CommandId } from "./commands.ts";
import { EditorPane } from "./EditorPane.tsx";
import { FindBar, type FindMode } from "./find/FindBar.tsx";
import { type Translate, useT } from "./i18n/index.ts";
import type { Platform } from "./platform/platform.ts";
import { SettingsDialog } from "./settings/SettingsDialog.tsx";
import { SettingsIssues } from "./settings/SettingsIssues.tsx";
import { TabStoreContext, useTabStore, useTabsState } from "./tabs/context.ts";
import { baseName } from "./tabs/paths.ts";
import { TabBar } from "./tabs/TabBar.tsx";
import { createTabStore, type Tab, type TabError, type TabStore } from "./tabs/tab-store.ts";

/** One window of the shell. Each window owns its own tabs; nothing is shared between windows. */
export function App({ platform }: { readonly platform: Platform }) {
  const t = useT();
  const translate = useRef(t);
  translate.current = t;
  const [store] = useState(() =>
    createTabStore({
      platform,
      askUnsaved: (tab) => askUnsaved(platform, translate.current, tab),
    }),
  );

  return (
    <TabStoreContext value={store}>
      <Window platform={platform} store={store} />
    </TabStoreContext>
  );
}

async function askUnsaved(platform: Platform, t: Translate, tab: Tab) {
  const answer = await platform.showQuestionDialog({
    title: t("unsaved.title"),
    message: t("unsaved.message", { name: baseName(tab.path) }),
    yes: t("unsaved.save"),
    no: t("unsaved.discard"),
    cancel: t("unsaved.cancel"),
  });
  return answer === "yes" ? "save" : answer === "no" ? "discard" : "cancel";
}

function Window({ platform, store }: { readonly platform: Platform; readonly store: TabStore }) {
  const t = useT();
  const { tabs, activeId, error } = useTabsState();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;

  const open = useCallback(async () => {
    const path = await platform.showOpenDialog({
      title: t("dialog.open.title"),
      filters: [{ name: t("dialog.filter.markdown"), extensions: ["md", "markdown"] }],
    });
    if (path) await store.openDocument(path);
  }, [platform, store, t]);

  const [find, setFind] = useState<{ mode: FindMode; request: number } | null>(null);
  const showFind = (mode: FindMode) => {
    if (activeId !== null) setFind((f) => ({ mode, request: (f?.request ?? 0) + 1 }));
  };

  const handlers = useRef<Record<CommandId, () => void>>({} as Record<CommandId, () => void>);
  handlers.current = {
    "file.open": () => void open(),
    "file.save": () => {
      if (activeId !== null) void store.save(activeId);
    },
    "edit.find": () => showFind("find"),
    "edit.replace": () => showFind("replace"),
    "tab.close": () => {
      if (activeId !== null) void store.close(activeId);
      else void platform.closeWindow();
    },
    "tab.next": () => store.activateNext(),
    "tab.previous": () => store.activatePrevious(),
    "window.new": () => void platform.openWindow(),
    "app.settings": () => setSettingsOpen(true),
  };

  useEffect(() => {
    void platform.setMenu(buildMenu(t, (id) => handlers.current[id]()));
  }, [platform, t]);

  useEffect(() => platform.onCloseRequested(() => store.closeAll()), [platform, store]);

  const name = active ? baseName(active.path) : null;
  const dirty = active?.dirty ?? false;
  useEffect(() => {
    const title = name
      ? t(dirty ? "window.titleUnsaved" : "window.title", { name })
      : t("app.name");
    void platform.setWindowTitle(title);
  }, [name, dirty, platform, t]);

  return (
    <div className="flex h-full flex-col bg-(--mint-bg) text-(--mint-fg)">
      <SettingsIssues />
      {error && (
        <div
          role="alert"
          className="border-b border-(--mint-border) bg-(--mint-error-bg) px-4 py-2 text-sm text-(--mint-error-fg)"
        >
          {errorMessage(t, error)}
        </div>
      )}
      {tabs.length > 0 && <TabBar />}
      {find && active && (
        <FindBar
          mode={find.mode}
          request={find.request}
          editorKey={active.id}
          getEditor={() => store.editor(active.id)}
          onClose={() => setFind(null)}
        />
      )}
      <main className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <TabPanel key={tab.id} tab={tab} active={tab.id === activeId} />
        ))}
        {tabs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <h1 className="text-lg font-medium">{t("welcome.title")}</h1>
            <p className="text-sm text-(--mint-muted)">{t("welcome.body")}</p>
            <button
              type="button"
              onClick={() => void open()}
              className="mt-2 rounded-md border border-(--mint-border) px-4 py-1.5 text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
            >
              {t("welcome.open")}
            </button>
          </div>
        )}
      </main>
      {active && (
        <footer className="flex items-center justify-between border-t border-(--mint-border) px-4 py-1 text-xs text-(--mint-muted)">
          <span title={active.path}>{name}</span>
          <span>{t(dirty ? "status.unsaved" : "status.saved")}</span>
        </footer>
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onOpenFile={(path) => void store.openDocument(path)}
        />
      )}
    </div>
  );
}

/** Every open tab keeps its editor mounted, so undo history and selection survive switching. */
function TabPanel({ tab, active }: { readonly tab: Tab; readonly active: boolean }) {
  const store = useTabStore();
  const { id } = tab;
  const onReady = useCallback(
    (editor: Parameters<TabStore["attachEditor"]>[1]) => store.attachEditor(id, editor),
    [store, id],
  );
  const onChange = useCallback(() => store.markChanged(id), [store, id]);
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      className="h-full"
    >
      <EditorPane text={tab.text} active={active} onReady={onReady} onChange={onChange} />
    </div>
  );
}

function errorMessage(t: Translate, error: TabError): string {
  const params = { path: error.path, reason: error.reason };
  return error.kind === "open" ? t("error.open", params) : t("error.save", params);
}
