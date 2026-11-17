import { useCallback, useEffect, useRef, useState } from "react";
import { createAutosave } from "./autosave/autosave.ts";
import { buildMenu, type CommandId } from "./commands.ts";
import { EditorPane } from "./EditorPane.tsx";
import { type Translate, useT } from "./i18n/index.ts";
import type { Platform } from "./platform/platform.ts";
import { createRecovery, type Recovery, type RecoveryChoice } from "./recovery/recovery.ts";
import { SettingsDialog } from "./settings/SettingsDialog.tsx";
import { SettingsIssues } from "./settings/SettingsIssues.tsx";
import { useSettingsStore } from "./settings/useSettings.ts";
import { TabStoreContext, useTabStore, useTabsState } from "./tabs/context.ts";
import { baseName } from "./tabs/paths.ts";
import { TabBar } from "./tabs/TabBar.tsx";
import { createTabStore, type Tab, type TabError, type TabStore } from "./tabs/tab-store.ts";

/** One window of the shell. Each window owns its own tabs; nothing is shared between windows. */
export function App({ platform }: { readonly platform: Platform }) {
  const t = useT();
  const translate = useRef(t);
  translate.current = t;
  const settings = useSettingsStore();
  const [store] = useState(() =>
    createTabStore({
      platform,
      askUnsaved: (tab) => askUnsaved(platform, translate.current, tab),
    }),
  );
  const [autosave] = useState(() =>
    createAutosave({ store, isEnabled: () => settings.getSnapshot().settings.autosave }),
  );
  useEffect(() => () => autosave.dispose(), [autosave]);
  const [recovery] = useState(() => createRecovery({ platform, store }));
  useEffect(() => recovery.start(), [recovery]);
  useEffect(() => {
    void recovery.offerRestore((paths) => askRestore(platform, translate.current, paths));
  }, [platform, recovery]);

  const onEdited = useCallback(
    (id: number) => {
      autosave.edited(id);
      recovery.edited(id);
    },
    [autosave, recovery],
  );

  return (
    <TabStoreContext value={store}>
      <Window platform={platform} store={store} recovery={recovery} onEdited={onEdited} />
    </TabStoreContext>
  );
}

async function askRestore(
  platform: Platform,
  t: Translate,
  paths: readonly string[],
): Promise<RecoveryChoice> {
  const answer = await platform.showQuestionDialog({
    title: t("recovery.title"),
    message: t("recovery.message", { names: paths.map(baseName).join(t("recovery.separator")) }),
    yes: t("recovery.restore"),
    no: t("recovery.discard"),
    cancel: t("recovery.later"),
  });
  return answer === "yes" ? "restore" : answer === "no" ? "discard" : "later";
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

interface WindowProps {
  readonly platform: Platform;
  readonly store: TabStore;
  readonly recovery: Recovery;
  /** Called after every edit the user makes in a tab. */
  readonly onEdited: (id: number) => void;
}

function Window({ platform, store, recovery, onEdited }: WindowProps) {
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

  const handlers = useRef<Record<CommandId, () => void>>({} as Record<CommandId, () => void>);
  handlers.current = {
    "file.open": () => void open(),
    "file.save": () => {
      if (activeId !== null) void store.save(activeId);
    },
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

  useEffect(
    () =>
      platform.onCloseRequested(async () => {
        if (!(await store.closeAll())) return false;
        // Closed tabs need no recovery: let their snapshots be removed before the window goes.
        await recovery.settled();
        return true;
      }),
    [platform, store, recovery],
  );

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
      <main className="min-h-0 flex-1">
        {tabs.map((tab) => (
          <TabPanel key={tab.id} tab={tab} active={tab.id === activeId} onEdited={onEdited} />
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
function TabPanel({
  tab,
  active,
  onEdited,
}: {
  readonly tab: Tab;
  readonly active: boolean;
  readonly onEdited: (id: number) => void;
}) {
  const store = useTabStore();
  const { id } = tab;
  const onReady = useCallback(
    (editor: Parameters<TabStore["attachEditor"]>[1]) => store.attachEditor(id, editor),
    [store, id],
  );
  const onChange = useCallback(() => {
    store.markChanged(id);
    onEdited(id);
  }, [store, id, onEdited]);
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
