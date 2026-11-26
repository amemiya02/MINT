import type { WordCount } from "@mint/editor";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createAutosave } from "./autosave/autosave.ts";
import { CommandPalette } from "./command-palette/CommandPalette.tsx";
import {
  buildMenu,
  type CommandId,
  type EditorInvocation,
  findCommand,
  type ShellCommandId,
} from "./commands.ts";
import { ExportDialog } from "./export/ExportDialog.tsx";
import { FindBar, type FindMode } from "./find/FindBar.tsx";
import { FolderTree } from "./folder/file-tree.ts";
import { useRecent } from "./folder/recent.ts";
import { Sidebar, type SidebarView } from "./folder/Sidebar.tsx";
import { type Translate, useT } from "./i18n/index.ts";
import { documentExtensions } from "./paths.ts";
import type { Platform } from "./platform/platform.ts";
import { QuickOpen } from "./quick-open/QuickOpen.tsx";
import { createRecovery, type Recovery } from "./recovery/recovery.ts";
import { FolderSearch } from "./search/FolderSearch.tsx";
import { SettingsDialog } from "./settings/SettingsDialog.tsx";
import { SettingsIssues } from "./settings/SettingsIssues.tsx";
import { useSettings, useSettingsStore } from "./settings/useSettings.ts";
import { TabStoreContext, useTabsState } from "./tabs/context.ts";
import { TabBar } from "./tabs/TabBar.tsx";
import { tabName } from "./tabs/tab-name.ts";
import { createTabStore, type TabError, type TabStore } from "./tabs/tab-store.ts";
import { ThemeIssue } from "./theme/ThemeIssue.tsx";
import { UpdateNotice, useUpdates } from "./updates/updates.tsx";
import { askRestore, askSavePath, askUnsaved } from "./window/questions.ts";
import { StatusBar } from "./window/StatusBar.tsx";
import { TabPanel } from "./window/TabPanel.tsx";
import { useOverlays } from "./window/useOverlays.ts";
import { Welcome } from "./window/Welcome.tsx";

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
      askSavePath: (tab) => askSavePath(platform, translate.current, tab),
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

interface WindowProps {
  readonly platform: Platform;
  readonly store: TabStore;
  readonly recovery: Recovery;
  /** Called after every edit the user makes in a tab. */
  readonly onEdited: (id: number) => void;
}

function Window({ platform, store, recovery, onEdited }: WindowProps) {
  const t = useT();
  const settings = useSettingsStore();
  const { tabs, activeId, error } = useTabsState();
  const {
    settingsOpen,
    setSettingsOpen,
    quickOpenVisible,
    setQuickOpenVisible,
    paletteVisible,
    setPaletteVisible,
    recordingShortcut,
    setRecordingShortcut,
    exporting,
    setExporting,
    find,
    setFind,
    folderSearch,
    setFolderSearch,
  } = useOverlays();
  const { shortcuts } = useSettings().settings;
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const updates = useUpdates(platform);
  const [tree, setTree] = useState<FolderTree | null>(null);
  const folder = tree?.root ?? null;
  const openFolderState = useRef<{ request: number; tree?: FolderTree }>({ request: 0 });
  useEffect(
    () => () => {
      openFolderState.current.request++;
      openFolderState.current.tree?.dispose();
    },
    [],
  );
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarView, setSidebarView] = useState<SidebarView>("files");
  // Without a folder the sidebar only has the outline, shown once asked for.
  const sidebarShown = sidebarVisible && (folder !== null || sidebarView === "outline");
  // Editors attach after their tab mounts; re-render so the outline finds the active one.
  const [, editorsChanged] = useReducer((n: number) => n + 1, 0);
  /** Errors from folder actions and other shell commands; document errors live in the tab store. */
  const [shellError, setShellError] = useState<string | null>(null);
  const { recent, add: addRecent } = useRecent(platform);

  // Every document shown in this window, however it was opened, counts as recent.
  const activePath = active?.path ?? null;
  useEffect(() => {
    if (activePath === null) return;
    addRecent("document", activePath);
    setShellError(null);
  }, [activePath, addRecent]);

  const openFolder = useCallback(
    async (path: string) => {
      const request = ++openFolderState.current.request;
      setShellError(null);
      try {
        const opened = await FolderTree.open(platform, path, (error) => {
          if (request === openFolderState.current.request)
            setShellError(t("error.watch", { path, reason: reasonOf(error) }));
        });
        if (request !== openFolderState.current.request) {
          opened.dispose();
          return;
        }
        openFolderState.current.tree?.dispose();
        openFolderState.current.tree = opened;
        setTree(opened);
      } catch (e) {
        if (request === openFolderState.current.request)
          setShellError(t("error.openFolder", { path, reason: reasonOf(e) }));
        return;
      }
      setSidebarVisible(true);
      addRecent("folder", path);
    },
    [platform, t, addRecent],
  );

  const pickFolder = useCallback(async () => {
    const path = await platform.showOpenFolderDialog({ title: t("dialog.openFolder.title") });
    if (path) await openFolder(path);
  }, [platform, t, openFolder]);
  // The editor owns its mode; re-render when it reports a change.
  const [, modeChanged] = useReducer((n: number) => n + 1, 0);
  const mode = (activeId !== null && store.editor(activeId)?.getMode()) || "livePreview";
  /** Word count of the active document, as its editor last reported it. */
  const [wordCount, setWordCount] = useState<WordCount | null>(null);

  const open = useCallback(async () => {
    const path = await platform.showOpenDialog({
      title: t("dialog.open.title"),
      filters: [{ name: t("dialog.filter.markdown"), extensions: documentExtensions }],
    });
    if (path) await store.openDocument(path);
  }, [platform, store, t]);

  // Documents and folders handed over from outside (file manager, command line, a second launch).
  const openFolderRef = useRef(openFolder);
  openFolderRef.current = openFolder;
  useEffect(
    () =>
      platform.onOpenPaths((paths) => {
        for (const { path, kind } of paths) {
          if (kind === "directory") void openFolderRef.current(path);
          else void store.openDocument(path);
        }
      }),
    [platform, store],
  );

  const showFind = (mode: FindMode) => {
    if (activeId !== null) setFind((f) => ({ mode, request: (f?.request ?? 0) + 1 }));
  };

  const handlers = useRef<Record<ShellCommandId, () => void>>(
    {} as Record<ShellCommandId, () => void>,
  );
  handlers.current = {
    "file.open": () => void open(),
    "file.openFolder": () => void pickFolder(),
    "file.quickOpen": () => setQuickOpenVisible(true),
    "file.new": () => void store.newDocument(),
    "file.save": () => {
      if (activeId !== null) void store.save(activeId);
    },
    "file.saveAs": () => {
      if (activeId !== null) void store.saveAs(activeId);
    },
    "file.exportHtml": () => {
      if (activeId !== null) setExporting({ tab: activeId, format: "html" });
    },
    "file.exportPdf": () => {
      if (activeId !== null) setExporting({ tab: activeId, format: "pdf" });
    },
    "edit.find": () => showFind("find"),
    "edit.replace": () => showFind("replace"),
    "edit.searchFolder": () => setFolderSearch((request) => (request ?? 0) + 1),
    "edit.pastePlainText": () => {
      const editor = activeId === null ? undefined : store.editor(activeId);
      if (!editor) return;
      void platform.readClipboardText().then(
        (text) => {
          if (text) editor.execute("pastePlainText", text);
          editor.focus();
        },
        (e: unknown) => setShellError(t("error.pastePlainText", { reason: reasonOf(e) })),
      );
    },
    "edit.toggleSpellcheck": () =>
      void settings.set("spellcheck", !settings.getSnapshot().settings.spellcheck),
    "view.toggleVimMode": () =>
      void settings.set("vimMode", !settings.getSnapshot().settings.vimMode),
    "tab.close": () => {
      if (activeId !== null) void store.close(activeId);
      else void platform.closeWindow();
    },
    "tab.next": () => store.activateNext(),
    "tab.previous": () => store.activatePrevious(),
    "view.toggleSidebar": () => {
      if (!sidebarShown && folder === null) setSidebarView("outline");
      setSidebarVisible(!sidebarShown);
    },
    "view.outline": () => {
      setFolderSearch(null);
      if (sidebarShown && sidebarView === "outline") {
        setSidebarVisible(false);
      } else {
        setSidebarView("outline");
        setSidebarVisible(true);
      }
    },
    "view.toggleFocusMode": () =>
      void settings.set("focusMode", !settings.getSnapshot().settings.focusMode),
    "view.toggleTypewriterMode": () =>
      void settings.set("typewriterMode", !settings.getSnapshot().settings.typewriterMode),
    "window.new": () => void platform.openWindow(),
    "app.settings": () => setSettingsOpen(true),
    "app.checkForUpdates": () => updates.check(),
    "view.commandPalette": () => setPaletteVisible(true),
  };

  // Editor commands run on the active document; the others go to the handlers above.
  const run = useRef<(id: CommandId) => void>(() => {});
  run.current = (id) => {
    const { editor: invocation } = findCommand(id);
    if (!invocation) {
      handlers.current[id as ShellCommandId]();
      return;
    }
    const editor = activeId === null ? undefined : store.editor(activeId);
    if (!editor) return;
    // `execute` is generic per command; an invocation pairs a command with its own arguments.
    (editor.execute as unknown as (...call: EditorInvocation) => boolean)(...invocation);
    editor.focus();
  };

  useEffect(() => {
    void platform.setMenu(buildMenu(t, (id) => run.current(id), shortcuts, !recordingShortcut));
  }, [platform, t, shortcuts, recordingShortcut]);

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

  const exportedTab = tabs.find((tab) => tab.id === exporting?.tab) ?? null;
  const name = active ? tabName(t, active) : null;
  const dirty = active?.dirty ?? false;
  useEffect(() => {
    const title = name
      ? t(dirty ? "window.titleUnsaved" : "window.title", { name })
      : t("app.name");
    void platform.setWindowTitle(title);
  }, [name, dirty, platform, t]);

  return (
    <div className="flex h-full flex-col bg-(--mint-bg) text-(--mint-fg)">
      <UpdateNotice updates={updates} />
      <SettingsIssues />
      <ThemeIssue />
      {(shellError || error) && (
        <div
          role="alert"
          className="border-b border-(--mint-border) bg-(--mint-error-bg) px-4 py-2 text-sm text-(--mint-error-fg)"
        >
          {shellError ?? (error && errorMessage(t, error))}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {folderSearch !== null && (
          <FolderSearch
            platform={platform}
            folder={folder}
            request={folderSearch}
            onOpenDocument={(path, select) => void store.openDocument(path, select)}
            onClose={() => {
              setFolderSearch(null);
              if (activeId !== null) store.editor(activeId)?.focus();
            }}
          />
        )}
        {folderSearch === null && sidebarShown && (
          <Sidebar
            tree={tree}
            view={sidebarView}
            onViewChange={setSidebarView}
            editor={activeId === null ? null : store.editor(activeId)}
            activePath={activePath}
            onOpenDocument={(path) => void store.openDocument(path)}
            onRenamed={(from, to) => store.pathRenamed(from, to)}
            onTrashed={(path) => store.pathTrashed(path)}
            onError={setShellError}
            onHide={() => setSidebarVisible(false)}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
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
              <TabPanel
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                platform={platform}
                onModeChange={modeChanged}
                onEditorChange={editorsChanged}
                onEdited={onEdited}
                onWordCount={setWordCount}
              />
            ))}
            {tabs.length === 0 && (
              <Welcome
                recent={recent}
                onPickDocument={() => void open()}
                onPickFolder={() => void pickFolder()}
                onOpenDocument={(path) => void store.openDocument(path)}
                onOpenFolder={(path) => void openFolder(path)}
              />
            )}
          </main>
          {active && <StatusBar tab={active} name={name ?? ""} mode={mode} wordCount={wordCount} />}
        </div>
      </div>
      {paletteVisible && (
        <CommandPalette onRun={(id) => run.current(id)} onClose={() => setPaletteVisible(false)} />
      )}
      {quickOpenVisible && (
        <QuickOpen
          platform={platform}
          folder={folder}
          recentDocuments={recent.documents}
          onOpenDocument={(path) => void store.openDocument(path)}
          onClose={() => setQuickOpenVisible(false)}
        />
      )}
      {exportedTab && (
        <ExportDialog
          platform={platform}
          format={exporting?.format ?? "html"}
          path={exportedTab.path ?? tabName(t, exportedTab)}
          getText={() => store.editor(exportedTab.id)?.getText() ?? exportedTab.text}
          onClose={() => {
            setExporting(null);
            store.editor(exportedTab.id)?.focus();
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => {
            setSettingsOpen(false);
            setRecordingShortcut(false);
          }}
          onRecordingShortcut={setRecordingShortcut}
          onOpenFile={(path) => void store.openDocument(path)}
        />
      )}
    </div>
  );
}

function errorMessage(t: Translate, error: TabError): string {
  const params = { path: error.path, reason: error.reason };
  return t(`error.${error.kind}`, params);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
