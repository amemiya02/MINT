import type { AnnotationTarget, WordCount } from "@mint/editor";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { DraftComposer } from "./ai/DraftComposer.tsx";
import { ExternalAgentDialog } from "./ai/ExternalAgentPanel.tsx";
import { inlineCompletionSender } from "./ai/inline-completion.ts";
import { ReplyExcerpt } from "./ai/ReplyExcerpt.tsx";
import { captureWritingSelection, type WritingSelection } from "./ai/writing-selection.ts";
import { AnnotationDialog, AnnotationPanel } from "./annotations/Annotations.tsx";
import { createAnnotationStorage } from "./annotations/annotation-storage.ts";
import { createAutosave } from "./autosave/autosave.ts";
import { Backlinks } from "./backlinks/Backlinks.tsx";
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
import { Bookmarks } from "./folder/Bookmarks.tsx";
import { FolderTree } from "./folder/file-tree.ts";
import { MoveDialog } from "./folder/MoveDialog.tsx";
import {
  applyMove,
  inverse,
  type MovePreview,
  previewMove,
  validateMovePreview,
} from "./folder/move-links.ts";
import { useRecent } from "./folder/recent.ts";
import { NavigationRail, Sidebar, type SidebarTool } from "./folder/Sidebar.tsx";
import { HistoryDialog } from "./history/HistoryDialog.tsx";
import { type Translate, useT } from "./i18n/index.ts";
import { documentExtensions, isWithin, joinPath } from "./paths.ts";
import type { DocumentEdit, Platform } from "./platform/platform.ts";
import { canPresentSlides, insertTemplate, journalTemplate } from "./plugins/host.ts";
import { KanbanBoard } from "./plugins/KanbanBoard.tsx";
import { PluginEntries, pluginName, useInstallations } from "./plugins/Plugins.tsx";
import { PresentationEntry } from "./plugins/Presentation.tsx";
import { PropertyTable } from "./plugins/PropertyTable.tsx";
import { RelationshipGraph } from "./plugins/RelationshipGraph.tsx";
import { TagBrowser } from "./plugins/TagBrowser.tsx";
import { TaskSummary } from "./plugins/TaskSummary.tsx";
import { timingRenderer } from "./plugins/timing-diagrams.ts";
import { ZoteroCitation } from "./plugins/ZoteroCitation.tsx";
import { QuickOpen } from "./quick-open/QuickOpen.tsx";
import { createRecovery, type Recovery } from "./recovery/recovery.ts";
import { FolderSearch } from "./search/FolderSearch.tsx";
import { SettingsDialog } from "./settings/SettingsDialog.tsx";
import { SettingsIssues } from "./settings/SettingsIssues.tsx";
import { useDialect } from "./settings/useDialect.ts";
import { useSettings, useSettingsStore } from "./settings/useSettings.ts";
import { TabStoreContext, useTabsState } from "./tabs/context.ts";
import { TabBar } from "./tabs/TabBar.tsx";
import { tabName } from "./tabs/tab-name.ts";
import { createTabStore, type Pane, type TabError, type TabStore } from "./tabs/tab-store.ts";
import { ThemeIssue } from "./theme/ThemeIssue.tsx";
import { UpdateNotice, useUpdates } from "./updates/updates.tsx";
import type { ToolbarPosition } from "./window/FormattingToolbar.tsx";
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
      askSavePath: (tab, knownPaths) => askSavePath(platform, translate.current, tab, knownPaths),
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
  const { tabs, activeId, selected, error } = useTabsState();
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
  const { shortcuts, wikilinkFolders, inlineCompletionModel } = useSettings().settings;
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const [draftTabs, setDraftTabs] = useState<ReadonlySet<number>>(() => new Set());
  const [writingRequest, setWritingRequest] = useState<{ tabId: number; sequence: number } | null>(
    null,
  );
  const [agentSelection, setAgentSelection] = useState<{
    tabId: number;
    origin: WritingSelection;
  } | null>(null);
  useEffect(() => () => agentSelection?.origin.range.release(), [agentSelection]);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [annotationError, setAnnotationError] = useState<{ path: string; reason: string } | null>(
    null,
  );
  const [annotationStorage] = useState(() =>
    createAnnotationStorage(platform, store, (path, error) =>
      setAnnotationError({ path, reason: reasonOf(error) }),
    ),
  );
  useEffect(() => annotationStorage.start(), [annotationStorage]);
  const [annotationDraft, setAnnotationDraft] = useState<{
    readonly tab: NonNullable<typeof active>;
    readonly target: AnnotationTarget;
  } | null>(null);
  function addAnnotation() {
    if (!active) return;
    setAnnotationsOpen(true);
    const target = store.editor(active.id)?.getAnnotationTarget();
    if (target) setAnnotationDraft({ tab: active, target });
  }
  const [toolbarPositions, setToolbarPositions] = useState<Record<Pane, ToolbarPosition>>({
    primary: "top",
    reference: "top",
  });
  function placeToolbar(position: ToolbarPosition) {
    if (!active) return;
    setToolbarPositions((previous) => ({ ...previous, [active.pane]: position }));
    store.editor(active.id)?.focus();
  }
  const updates = useUpdates(platform);
  const [tree, setTree] = useState<FolderTree | null>(null);
  const folder = tree?.root ?? null;
  const wikilinkFolder = folder && wikilinkFolders.includes(folder) ? folder : null;
  const openFolderState = useRef<{ request: number; tree?: FolderTree }>({ request: 0 });
  useEffect(
    () => () => {
      openFolderState.current.request++;
      openFolderState.current.tree?.dispose();
    },
    [],
  );
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [sidebarView, setSidebarView] = useState<Exclude<SidebarTool, "search">>("outline");
  const plugins = useInstallations();
  const timingEnabled = plugins.some(
    (i) => i.enabled && i.grants.includes("document.read") && "diagram" in i.manifest,
  );
  const codeBlockRenderers = useMemo(
    () => (timingEnabled ? [timingRenderer(t)] : []),
    [timingEnabled, t],
  );
  const sidebarPlugins = plugins.filter((i) => i.enabled && "sidebar" in i.manifest);
  const selectedPlugin = sidebarPlugins.find((i) => sidebarView === `plugin:${i.manifest.id}`);
  const PluginSidebar = {
    graph: RelationshipGraph,
    properties: PropertyTable,
    kanban: KanbanBoard,
    tags: TagBrowser,
    tasks: TaskSummary,
  }[selectedPlugin?.manifest.sidebar ?? "tags"];
  const removed = sidebarView.startsWith("plugin:") && !selectedPlugin;
  useEffect(() => {
    if (removed) {
      setSidebarView("files");
      setSidebarVisible(false);
    }
  }, [removed]);
  const sidebarTool = folderSearch !== null ? "search" : sidebarVisible ? sidebarView : null;

  function hideSidebar() {
    setFolderSearch(null);
    setSidebarVisible(false);
    if (activeId !== null) store.editor(activeId)?.focus();
  }

  function toggleTool(tool: SidebarTool) {
    if (tool === sidebarTool) hideSidebar();
    else if (tool === "search") setFolderSearch(1);
    else {
      setFolderSearch(null);
      setSidebarView(tool);
      setSidebarVisible(true);
    }
  }
  // Editors attach after their tab mounts; re-render so the outline finds the active one.
  const [, editorsChanged] = useReducer((n: number) => n + 1, 0);
  const activeEditor = activeId === null ? null : store.editor(activeId);
  useLayoutEffect(() => {
    if (!activeEditor || !inlineCompletionModel) return;
    const send = inlineCompletionSender(platform.sendModelMessage, inlineCompletionModel);
    activeEditor.setInlineCompletion((context) =>
      store.getState().activeId === activeId &&
      settings.getSnapshot().settings.inlineCompletionModel === inlineCompletionModel
        ? send(context)
        : Promise.resolve(null),
    );
    return () => activeEditor.setInlineCompletion(null);
  }, [activeEditor, activeId, inlineCompletionModel, platform, settings, store]);
  /** Errors from folder actions and other shell commands; document errors live in the tab store. */
  const [shellError, setShellError] = useState<string | null>(null);
  const dialect = useDialect();
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [undoMove, setUndoMove] = useState<DocumentEdit[] | null>(null);
  const moving = useRef(false);
  async function performMove(edits: DocumentEdit[], undo = false, confirmed?: MovePreview) {
    if (moving.current) return;
    moving.current = true;
    setPreview(null);
    try {
      if (confirmed) await validateMovePreview(platform, confirmed, t);
      await applyMove(
        platform,
        edits,
        (path) => store.getState().tabs.some((tab) => tab.path === path && tab.dirty),
        t,
      );
      const relocated = edits.find((edit) => edit.from !== edit.to);
      if (relocated) store.pathRenamed(relocated.from, relocated.to);
      setShellError(null);
      setUndoMove(undo ? null : inverse(edits));
    } catch (error) {
      setShellError(reasonOf(error));
    } finally {
      moving.current = false;
    }
  }
  async function moveDocument(from: string, to: string) {
    if (!folder || moving.current) return;
    moving.current = true;
    const request = openFolderState.current.request;
    let planned: MovePreview;
    try {
      planned = await previewMove(platform, folder, from, to, {
        ...dialect,
        wikilinks: wikilinkFolder !== null,
      });
    } catch (error) {
      setShellError(reasonOf(error));
      return;
    } finally {
      moving.current = false;
    }
    if (request !== openFolderState.current.request) return;
    if (planned.documents.length) setPreview(planned);
    else await performMove([planned.moveOnly]);
  }
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
        setPreview(null);
        setUndoMove(null);
      } catch (e) {
        if (request === openFolderState.current.request)
          setShellError(t("error.openFolder", { path, reason: reasonOf(e) }));
        return;
      }
      setSidebarView("files");
      setFolderSearch(null);
      setSidebarVisible(true);
      addRecent("folder", path);
    },
    [platform, t, addRecent, setFolderSearch],
  );

  async function openJournal(id: string) {
    const template = journalTemplate(id);
    if (template === undefined) {
      setShellError(t("journal.denied"));
      return;
    }
    if (!folder) {
      setShellError(t("journal.needFolder"));
      return;
    }
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const date = `${today.getFullYear()}-${month}-${day}`;
    const path = joinPath(folder, `${date}.md`);
    const request = openFolderState.current.request;
    setShellError(null);
    try {
      await platform.ensureDocument(path, template.replaceAll("{{date}}", date));
      if (request === openFolderState.current.request) await store.openDocument(path);
    } catch (error) {
      setShellError(t("journal.failed", { path, reason: reasonOf(error) }));
    }
  }

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

  function emptyDraftEditor(id: number) {
    const tab = store.getState().tabs.find((tab) => tab.id === id);
    if (tab?.path !== null) return null;
    const editor = store.editor(id);
    return editor?.getText() === "" ? editor : null;
  }

  const handlers = useRef<Record<ShellCommandId, () => void>>(
    {} as Record<ShellCommandId, () => void>,
  );
  handlers.current = {
    "file.open": () => void open(),
    "file.openFolder": () => void pickFolder(),
    "file.quickOpen": () => setQuickOpenVisible(true),
    "file.new": () => void store.newDocument(),
    "file.draftWithAi": () => {
      const id = active && emptyDraftEditor(active.id) ? active.id : store.newDocument();
      setDraftTabs((previous) => new Set([...previous, id]));
    },
    "file.save": () => {
      if (activeId !== null) void store.save(activeId);
    },
    "file.saveAs": () => {
      if (activeId !== null) void store.saveAs(activeId);
    },
    "file.history": () => setHistoryPath(active?.path ?? null),
    "file.export": () => {
      if (activeId !== null || plugins.some((i) => i.enabled && "importer" in i.manifest))
        setExporting({ tab: activeId });
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
    "edit.askAI": () => {
      const selection = activeId === null ? undefined : store.editor(activeId)?.getSelection();
      if (activeId === null || !selection || selection.anchor === selection.head) {
        setShellError(t("writing.needSelection"));
        return;
      }
      setShellError(null);
      setWritingRequest((previous) => ({
        tabId: activeId,
        sequence: (previous?.sequence ?? 0) + 1,
      }));
    },
    "edit.addAnnotation": addAnnotation,
    "view.annotations": () => {
      if (active) setAnnotationsOpen((open) => !open);
    },
    "edit.askExternalAgent": () => {
      const editor = activeId === null ? undefined : store.editor(activeId);
      const origin = editor && captureWritingSelection(editor);
      if (activeId === null || !origin) {
        setShellError(t("agent.needSelection"));
        return;
      }
      setShellError(null);
      setAgentSelection({ tabId: activeId, origin });
    },
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
    "edit.toggleProofreading": () => {
      const { proofreading, proofreadingModel } = settings.getSnapshot().settings;
      void settings.set("proofreading", !proofreading);
      if (!proofreading && !proofreadingModel) setSettingsOpen(true);
    },
    "view.toggleVimMode": () =>
      void settings.set("vimMode", !settings.getSnapshot().settings.vimMode),
    "tab.close": () => {
      if (activeId !== null) void store.close(activeId);
      else void platform.closeWindow();
    },
    "view.openInOtherPane": () => {
      if (activeId !== null) store.openInOtherPane(activeId);
    },
    "view.toolbarTop": () => placeToolbar("top"),
    "view.toolbarSide": () => placeToolbar("side"),
    "view.toolbarHide": () => placeToolbar("hidden"),
    "view.focusOtherPane": () => store.focusOtherPane(),
    "view.closeReferencePane": () => store.closeReferencePane(),
    "tab.next": () => store.activateNext(),
    "tab.previous": () => store.activatePrevious(),
    "view.toggleSidebar": () => {
      if (sidebarTool === null) setSidebarVisible(true);
      else hideSidebar();
    },
    "view.outline": () => toggleTool("outline"),
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
        await Promise.all([recovery.settled(), annotationStorage.settled()]);
        return true;
      }),
    [platform, store, recovery, annotationStorage],
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

  function insertAtSelection(text: string) {
    const editor = activeId === null ? null : store.editor(activeId);
    if (!editor) return false;
    editor.execute("pastePlainText", text);
    editor.focus();
    return true;
  }

  return (
    <div className="flex h-full flex-col bg-(--mint-bg) text-(--mint-fg)">
      <UpdateNotice updates={updates} />
      <SettingsIssues />
      <ThemeIssue />
      {annotationError && (
        <div
          role="alert"
          className="border-b border-(--mint-border) bg-(--mint-error-bg) px-4 py-2 text-sm text-(--mint-error-fg)"
        >
          {t("annotations.storageError", annotationError)}
        </div>
      )}
      {undoMove && (
        <button
          className="self-end px-3 py-1 text-sm underline"
          type="button"
          onClick={() => void performMove(undoMove, true)}
        >
          {t("move.undo")}
        </button>
      )}
      {preview && folder && (
        <MoveDialog
          preview={preview}
          folder={folder}
          onClose={() => setPreview(null)}
          onChoose={(edits, updateLinks) =>
            void performMove(edits, false, updateLinks ? preview : undefined)
          }
        />
      )}
      {(shellError || error) && (
        <div
          role="alert"
          className="border-b border-(--mint-border) bg-(--mint-error-bg) px-4 py-2 text-sm text-(--mint-error-fg)"
        >
          {shellError ?? (error && errorMessage(t, error))}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <NavigationRail
          plugins={sidebarPlugins.map((i) => ({
            id: i.manifest.id,
            label: pluginName(i.manifest, t),
          }))}
          active={sidebarTool}
          onToggle={toggleTool}
        />
        {folderSearch !== null && (
          <FolderSearch
            platform={platform}
            folder={folder}
            editor={activeId === null ? null : store.editor(activeId)}
            documentName={name}
            request={folderSearch}
            onOpenDocument={(path, select) => void store.openDocument(path, select)}
            onClose={() => {
              setFolderSearch(null);
              if (activeId !== null) store.editor(activeId)?.focus();
            }}
          />
        )}
        {sidebarTool === "bookmarks" && (
          <Bookmarks activePath={activePath} onOpen={(path) => void store.openDocument(path)} />
        )}
        {folderSearch === null && sidebarVisible && sidebarView === "backlinks" && (
          <Backlinks
            key={JSON.stringify([folder, activePath])}
            platform={platform}
            tree={tree}
            wikilinks={wikilinkFolder !== null}
            targetPath={activePath}
            onOpen={(link) => void store.openDocument(link.sourcePath, { citation: link })}
          />
        )}
        {folderSearch === null && sidebarVisible && selectedPlugin && (
          <PluginSidebar
            key={JSON.stringify([
              selectedPlugin.manifest.id,
              folder,
              selectedPlugin.grants.includes("folder.read"),
            ])}
            manifest={selectedPlugin.manifest}
            granted={selectedPlugin.grants.includes("folder.read")}
            folder={folder}
            tree={tree}
            wikilinks={wikilinkFolder !== null}
            platform={platform}
            onOpen={(path, location) => void store.openDocument(path, location)}
          />
        )}
        {folderSearch === null &&
          sidebarVisible &&
          (sidebarView === "files" || sidebarView === "outline") && (
            <Sidebar
              tree={tree}
              view={sidebarView}
              onOpenFolder={() => void pickFolder()}
              editor={activeId === null ? null : store.editor(activeId)}
              activePath={activePath}
              onOpenDocument={(path) => void store.openDocument(path)}
              onMoveDocument={moveDocument}
              onRenamed={(from, to) => store.pathRenamed(from, to)}
              onTrashed={(path) => store.pathTrashed(path)}
              onError={setShellError}
              onHide={hideSidebar}
            />
          )}
        <div className="flex min-w-0 flex-1 flex-col md:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {tabs.length > 0 && (
              <div
                className={
                  selected.reference === null
                    ? "grid"
                    : "grid grid-cols-2 divide-x divide-(--mint-border)"
                }
              >
                <TabBar pane="primary" />
                {selected.reference !== null && <TabBar pane="reference" />}
              </div>
            )}
            {find && active && (
              <FindBar
                mode={find.mode}
                request={find.request}
                editorKey={active.id}
                getEditor={() => store.editor(active.id)}
                onClose={() => setFind(null)}
              />
            )}
            <main
              className={`grid min-h-0 flex-1 grid-rows-1 ${selected.reference === null ? "grid-cols-1" : "grid-cols-2"}`}
            >
              {tabs.map((tab) => (
                <TabPanel
                  key={tab.id}
                  tab={tab}
                  wikilinkFolder={
                    wikilinkFolder && tab.path && isWithin(tab.path, wikilinkFolder)
                      ? wikilinkFolder
                      : null
                  }
                  onLinkError={setShellError}
                  codeBlockRenderers={codeBlockRenderers}
                  active={tab.id === activeId}
                  visible={selected[tab.pane] === tab.id}
                  toolbarPosition={toolbarPositions[tab.pane]}
                  platform={platform}
                  folder={folder}
                  askWriting={writingRequest?.tabId === tab.id ? writingRequest.sequence : null}
                  settingsOpen={settingsOpen}
                  onAskWriting={() => run.current("edit.askAI")}
                  onOpenSettings={() => run.current("app.settings")}
                  onModeChange={modeChanged}
                  onEditorChange={editorsChanged}
                  onEdited={onEdited}
                  onWordCount={setWordCount}
                  drafting={
                    draftTabs.has(tab.id) ? (
                      <DraftComposer
                        platform={platform}
                        folder={folder}
                        settingsOpen={settingsOpen}
                        canApplyDraft={() => emptyDraftEditor(tab.id) !== null}
                        onDraft={(text) => {
                          const editor = emptyDraftEditor(tab.id);
                          if (!editor) return false;
                          editor.replaceText(text);
                          return true;
                        }}
                        onClose={() => {
                          setDraftTabs((previous) => {
                            const next = new Set(previous);
                            next.delete(tab.id);
                            return next;
                          });
                          if (store.getState().activeId === tab.id) store.editor(tab.id)?.focus();
                        }}
                      />
                    ) : activeId === tab.id && tab.path === null && !tab.dirty ? (
                      <button
                        type="button"
                        className="self-start px-4 py-2 text-sm text-(--mint-accent) underline focus-visible:outline-2"
                        onClick={() => run.current("file.draftWithAi")}
                      >
                        {t("command.file.draftWithAi")}
                      </button>
                    ) : null
                  }
                />
              ))}
              {tabs.length === 0 && (
                <Welcome
                  recent={recent}
                  onNewDocument={() => run.current("file.new")}
                  onDraft={() => run.current("file.draftWithAi")}
                  onPickDocument={() => void open()}
                  onPickFolder={() => void pickFolder()}
                  onOpenDocument={(path) => void store.openDocument(path)}
                  onOpenFolder={(path) => void openFolder(path)}
                />
              )}
            </main>
            {active && (
              <StatusBar
                openHistory={() => setHistoryPath(active.path)}
                addAnnotation={addAnnotation}
                toggleAnnotations={() => run.current("view.annotations")}
                annotationsOpen={annotationsOpen}
                tab={active}
                name={name ?? ""}
                mode={mode}
                wordCount={wordCount}
              />
            )}
          </div>
          {active && annotationsOpen && (
            <AnnotationPanel
              annotations={active.document.annotations}
              onClose={() => {
                setAnnotationsOpen(false);
                store.editor(active.id)?.focus();
              }}
              onReveal={(item) => store.editor(active.id)?.revealAnnotation(item)}
            />
          )}
        </div>
      </div>
      {active && canPresentSlides(plugins) && (
        <PresentationEntry
          key={active.id}
          editor={store.editor(active.id)}
          dialect={dialect}
          platform={platform}
          path={active.path}
        />
      )}
      {activeId !== null &&
        plugins
          .filter((i) => i.enabled && i.manifest.citation === "zotero")
          .map((i) => (
            <ZoteroCitation
              key={JSON.stringify([activeId, i.manifest.id])}
              id={i.manifest.id}
              platform={platform}
              granted={i.grants.includes("zotero.read") && i.grants.includes("document.write")}
              insert={insertAtSelection}
            />
          ))}
      <PluginEntries
        readDocument={() =>
          activeId === null ? null : (store.editor(activeId)?.getWordCount() ?? null)
        }
      />
      {paletteVisible && (
        <CommandPalette
          onRun={(id) => run.current(id)}
          onJournal={openJournal}
          onTemplate={(id, name) => {
            const result = insertTemplate(id, name, insertAtSelection);
            setShellError(
              result === "ok"
                ? null
                : t(result === "denied" ? "plugin.writeDenied" : "plugin.templateEmpty"),
            );
          }}
          onClose={() => setPaletteVisible(false)}
        />
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
      {historyPath && active?.path === historyPath && (
        <HistoryDialog
          path={historyPath}
          editor={store.editor(active.id)}
          platform={platform}
          onClose={() => {
            setHistoryPath(null);
            if (activeId !== null) store.editor(activeId)?.focus();
          }}
        />
      )}
      {annotationDraft && (
        <AnnotationDialog
          target={annotationDraft.target}
          onClose={() => {
            setAnnotationDraft(null);
            store.editor(annotationDraft.tab.id)?.focus();
          }}
          onSave={(note) => {
            const { tab, target } = annotationDraft;
            const editor = store.editor(tab.id);
            if (editor) tab.document.annotations.add(target, note, editor.getText());
          }}
        />
      )}
      {exporting && (
        <ExportDialog
          platform={platform}
          initialFormat={exporting?.format}
          onOpenFolder={openFolder}
          path={exportedTab ? (exportedTab.path ?? tabName(t, exportedTab)) : null}
          getText={() =>
            exportedTab ? (store.editor(exportedTab.id)?.getText() ?? exportedTab.text) : ""
          }
          onClose={() => {
            setExporting(null);
            if (exportedTab) store.editor(exportedTab.id)?.focus();
          }}
        />
      )}
      {agentSelection && (
        <ExternalAgentDialog
          platform={platform.externalAgent}
          selection={agentSelection.origin.text}
          renderReply={(reply, close) => (
            <ReplyExcerpt
              reply={reply}
              origin={agentSelection.origin}
              originId={agentSelection.tabId}
              onUsed={close}
            />
          )}
          onClose={() => {
            setAgentSelection(null);
            const current = store.getState().activeId;
            if (current !== null) store.editor(current)?.focus();
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          platform={platform}
          folder={folder}
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
  if (error.kind === "staleSearchResult" || error.kind === "staleCitation")
    return t(`error.${error.kind}`);
  if (error.kind === "alreadyOpen") return t("error.alreadyOpen", { path: error.path });
  if ("fragment" in error) return t(`error.${error.kind}`, { fragment: error.fragment });
  const params = { path: error.path, reason: error.reason };
  return t(`error.${error.kind}`, params);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
