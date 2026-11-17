import type { LinkTarget, WordCount } from "@mint/editor";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createImageHost, type ImageSaveFailure } from "./assets/image-host.ts";
import { createAutosave } from "./autosave/autosave.ts";
import { CommandPalette } from "./command-palette/CommandPalette.tsx";
import {
  buildMenu,
  type CommandId,
  type EditorInvocation,
  findCommand,
  type ShellCommandId,
} from "./commands.ts";
import { EditorPane } from "./EditorPane.tsx";
import { ExportDialog, type ExportFormat } from "./export/ExportDialog.tsx";
import { FindBar, type FindMode } from "./find/FindBar.tsx";
import { type RecentList, useRecent } from "./folder/recent.ts";
import { Sidebar, type SidebarView } from "./folder/Sidebar.tsx";
import { type Translate, useT } from "./i18n/index.ts";
import { baseName, documentExtensions, isAbsolutePath, resolveFrom } from "./paths.ts";
import type { Platform } from "./platform/platform.ts";
import { QuickOpen } from "./quick-open/QuickOpen.tsx";
import { createRecovery, type Recovery, type RecoveryChoice } from "./recovery/recovery.ts";
import { FolderSearch } from "./search/FolderSearch.tsx";
import { SettingsDialog } from "./settings/SettingsDialog.tsx";
import { SettingsIssues } from "./settings/SettingsIssues.tsx";
import { useDialect } from "./settings/useDialect.ts";
import { useSettings, useSettingsStore } from "./settings/useSettings.ts";
import { TabStoreContext, useTabStore, useTabsState } from "./tabs/context.ts";
import { ExternalChangeNotice } from "./tabs/ExternalChangeNotice.tsx";
import { TabBar } from "./tabs/TabBar.tsx";
import { tabName } from "./tabs/tab-name.ts";
import { createTabStore, type Tab, type TabError, type TabStore } from "./tabs/tab-store.ts";
import { ThemeIssue } from "./theme/ThemeIssue.tsx";
import { UpdateNotice, useUpdates } from "./updates/updates.tsx";

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

async function askRestore(
  platform: Platform,
  t: Translate,
  paths: readonly (string | null)[],
): Promise<RecoveryChoice> {
  const answer = await platform.showQuestionDialog({
    title: t("recovery.title"),
    message: t("recovery.message", {
      names: paths
        .map((path) => tabName(t, { path, untitled: null }))
        .join(t("recovery.separator")),
    }),
    yes: t("recovery.restore"),
    no: t("recovery.discard"),
    cancel: t("recovery.later"),
  });
  return answer === "yes" ? "restore" : answer === "no" ? "discard" : "later";
}

async function askUnsaved(platform: Platform, t: Translate, tab: Tab) {
  const answer = await platform.showQuestionDialog({
    title: t("unsaved.title"),
    message: t("unsaved.message", { name: tabName(t, tab) }),
    yes: t("unsaved.save"),
    no: t("unsaved.discard"),
    cancel: t("unsaved.cancel"),
  });
  return answer === "yes" ? "save" : answer === "no" ? "discard" : "cancel";
}

async function askSavePath(platform: Platform, t: Translate, tab: Tab) {
  return platform.showSaveDialog({
    title: t("dialog.saveAs.title"),
    defaultPath: tab.path ?? t("dialog.saveAs.defaultName"),
    filters: [{ name: t("dialog.filter.markdown"), extensions: documentExtensions }],
  });
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [paletteVisible, setPaletteVisible] = useState(false);
  /** True while the settings window records a shortcut: no shortcut may run meanwhile. */
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const { shortcuts } = useSettings().settings;
  /** The tab being exported, and to what, while the export dialog shows. */
  const [exporting, setExporting] = useState<{
    readonly tab: number;
    readonly format: ExportFormat;
  } | null>(null);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const updates = useUpdates(platform);
  const [folder, setFolder] = useState<string | null>(null);
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
      try {
        await platform.readDirectory(path);
      } catch (e) {
        setShellError(t("error.openFolder", { path, reason: reasonOf(e) }));
        return;
      }
      setFolder(path);
      setSidebarVisible(true);
      setShellError(null);
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

  const [find, setFind] = useState<{ mode: FindMode; request: number } | null>(null);
  /** While global search shows (in place of the file tree), how many times it was invoked. */
  const [folderSearch, setFolderSearch] = useState<number | null>(null);
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
            platform={platform}
            root={folder}
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
          {active && (
            <footer className="flex items-center justify-between border-t border-(--mint-border) px-4 py-1 text-xs text-(--mint-muted)">
              <span title={active.path ?? undefined}>{name}</span>
              <span className="flex gap-4">
                {wordCount && <WordCountStatus count={wordCount} />}
                <span>
                  {t(mode === "source" ? "status.mode.source" : "status.mode.livePreview")}
                </span>
                <span>{t(dirty ? "status.unsaved" : "status.saved")}</span>
              </span>
            </footer>
          )}
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

/** Every open tab keeps its editor mounted, so undo history and selection survive switching. */
function TabPanel({
  tab,
  active,
  platform,
  onModeChange,
  onEditorChange,
  onEdited,
  onWordCount,
}: {
  readonly tab: Tab;
  readonly active: boolean;
  readonly platform: Platform;
  readonly onModeChange: () => void;
  /** The tab's editor was created or destroyed. */
  readonly onEditorChange: () => void;
  readonly onEdited: (id: number) => void;
  readonly onWordCount: (count: WordCount) => void;
}) {
  const store = useTabStore();
  const { id, path } = tab;
  const onReady = useCallback(
    (editor: Parameters<TabStore["attachEditor"]>[1]) => {
      store.attachEditor(id, editor);
      onEditorChange();
    },
    [store, id, onEditorChange],
  );
  const onChange = useCallback(() => {
    store.markChanged(id);
    onEdited(id);
  }, [store, id, onEdited]);
  const currentPath = useRef(path);
  currentPath.current = path;
  const dialect = useDialect();
  const settings = useSettingsStore();
  const [imageFailure, setImageFailure] = useState<ImageSaveFailure | null>(null);
  const [imageHost] = useState(() =>
    createImageHost(
      platform,
      () => currentPath.current,
      () => settings.getSnapshot().settings,
      setImageFailure,
    ),
  );
  const onOpenLink = useCallback(
    (link: LinkTarget) => {
      if (link.kind === "external") void platform.openExternal(link.url);
      else if (path !== null) void store.openDocument(resolveFrom(path, link.path));
      // An untitled document has no folder for relative links to start from.
      else if (isAbsolutePath(link.path)) void store.openDocument(link.path);
    },
    [platform, store, path],
  );
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!active}
      className="flex h-full flex-col"
    >
      <ExternalChangeNotice tab={tab} />
      {imageFailure && (
        <ImageSaveNotice failure={imageFailure} onDismiss={() => setImageFailure(null)} />
      )}
      <div className="min-h-0 flex-1">
        <EditorPane
          text={tab.text}
          active={active}
          onReady={onReady}
          onChange={onChange}
          onModeChange={onModeChange}
          onOpenLink={onOpenLink}
          imageHost={imageHost}
          onWordCount={onWordCount}
          dialect={dialect}
        />
      </div>
    </div>
  );
}

/** Words, characters and reading time of the active document; Chinese counts per character. */
function WordCountStatus({ count }: { readonly count: WordCount }) {
  const t = useT();
  const plural = (key: "status.words" | "status.characters", n: number) =>
    n === 1 ? t(`${key}.one`) : t(`${key}.other`, { count: String(n) });
  return (
    <>
      <span>{plural("status.words", count.words)}</span>
      <span>{plural("status.characters", count.characters)}</span>
      <span>{t("status.readingTime", { minutes: String(count.readingMinutes) })}</span>
    </>
  );
}

/** Tells the user that a pasted or dropped image could not be saved in the asset folder. */
function ImageSaveNotice(props: {
  readonly failure: ImageSaveFailure;
  readonly onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 border-b border-(--mint-border) bg-(--mint-error-bg) px-4 py-2 text-sm text-(--mint-error-fg)"
    >
      <span>
        {props.failure.folder === null
          ? t("error.untitledImage")
          : t("error.saveImage", { ...props.failure, folder: props.failure.folder })}
      </span>
      <button
        type="button"
        onClick={props.onDismiss}
        className="shrink-0 rounded px-2 hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
      >
        {t("error.dismiss")}
      </button>
    </div>
  );
}

function errorMessage(t: Translate, error: TabError): string {
  const params = { path: error.path, reason: error.reason };
  return t(`error.${error.kind}`, params);
}

function Welcome(props: {
  readonly recent: RecentList;
  readonly onPickDocument: () => void;
  readonly onPickFolder: () => void;
  readonly onOpenDocument: (path: string) => void;
  readonly onOpenFolder: (path: string) => void;
}) {
  const t = useT();
  const { recent } = props;
  const button =
    "rounded-md border border-(--mint-border) px-4 py-1.5 text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)";
  const entries = [
    ...recent.folders.map((path) => ({ path, open: props.onOpenFolder, folder: true })),
    ...recent.documents.map((path) => ({ path, open: props.onOpenDocument, folder: false })),
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-medium">{t("welcome.title")}</h1>
      <p className="text-sm text-(--mint-muted)">{t("welcome.body")}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={props.onPickDocument} className={button}>
          {t("welcome.open")}
        </button>
        <button type="button" onClick={props.onPickFolder} className={button}>
          {t("welcome.openFolder")}
        </button>
      </div>
      {entries.length > 0 && (
        <section aria-labelledby="recent-heading" className="mt-6 w-full max-w-md text-left">
          <h2
            id="recent-heading"
            className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-(--mint-muted)"
          >
            {t("welcome.recent")}
          </h2>
          <ul>
            {entries.map((entry) => (
              <li key={`${entry.folder}:${entry.path}`}>
                <button
                  type="button"
                  onClick={() => entry.open(entry.path)}
                  className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-(--mint-hover) focus-visible:outline-2 focus-visible:outline-(--mint-accent)"
                >
                  <span className={entry.folder ? "font-medium" : ""}>
                    {baseName(entry.path)}
                    {entry.folder ? "/" : ""}
                  </span>
                  <span className="truncate text-xs text-(--mint-muted)">{entry.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
