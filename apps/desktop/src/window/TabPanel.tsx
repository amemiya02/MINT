import type { CodeBlockRenderer, DocumentLink, LinkTarget, WordCount } from "@mint/editor";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Proofreading } from "../ai/Proofreading.tsx";
import { WritingAssistant } from "../ai/WritingAssistant.tsx";
import type { SavedWritingTask } from "../ai/writing-tasks.ts";
import { createImageHost, type ImageSaveFailure } from "../assets/image-host.ts";
import { EditorPane } from "../EditorPane.tsx";
import { resolveDocumentLink } from "../folder/wikilinks.ts";
import { useT } from "../i18n/index.ts";
import { isAbsolutePath, isDocumentPath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { useDialect } from "../settings/useDialect.ts";
import { useSettings, useSettingsStore } from "../settings/useSettings.ts";
import { useTabStore } from "../tabs/context.ts";
import { ExternalChangeNotice } from "../tabs/ExternalChangeNotice.tsx";
import { tabName } from "../tabs/tab-name.ts";
import type { Tab, TabStore } from "../tabs/tab-store.ts";
import { FormattingToolbar, type ToolbarPosition } from "./FormattingToolbar.tsx";

import { LinkPreview } from "./LinkPreview.tsx";

/** Every open tab keeps its editor mounted, so undo history and selection survive switching. */
export function TabPanel({
  tab,
  wikilinkFolder,
  onLinkError,
  codeBlockRenderers,
  active,
  visible,
  toolbarPosition,
  platform,
  folder,
  askWriting,
  writingTaskRestore,
  writingTaskListRevision,
  settingsOpen,
  onAskWriting,
  onWritingTasks,
  onOpenSettings,
  onModeChange,
  onEditorChange,
  onEdited,
  onWordCount,
  drafting,
}: {
  readonly tab: Tab;
  readonly wikilinkFolder: string | null;
  readonly onLinkError: (message: string) => void;
  readonly codeBlockRenderers: readonly CodeBlockRenderer[];
  readonly active: boolean;
  readonly visible: boolean;
  readonly toolbarPosition: ToolbarPosition;
  readonly platform: Platform;
  readonly folder: string | null;
  readonly askWriting: { readonly folder?: string } | null;
  readonly writingTaskRestore: { readonly task: SavedWritingTask } | null;
  readonly writingTaskListRevision: number;
  readonly settingsOpen: boolean;
  readonly onAskWriting: () => void;
  readonly onWritingTasks: () => void;
  readonly onOpenSettings: () => void;
  readonly onModeChange: () => void;
  /** The tab's editor was created or destroyed. */
  readonly onEditorChange: () => void;
  readonly onEdited: (id: number) => void;
  readonly onWordCount: (count: WordCount) => void;
  readonly drafting: ReactNode;
}) {
  const store = useTabStore();
  const { id, path } = tab;
  const activate = useCallback(() => store.activate(id), [store, id]);
  const [preview, setPreview] = useState<DocumentLink | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Tabbing into a pane's toolbar activates the pane with focus already in the right place.
    if (active && !panel.current?.contains(document.activeElement)) store.editor(id)?.focus();
  }, [store, id, active]);
  const onReady = useCallback(
    (editor: Parameters<TabStore["attachEditor"]>[1]) => {
      store.attachEditor(id, editor);
      onEditorChange();
    },
    [store, id, onEditorChange],
  );
  const onChange = useCallback(
    (fromHistory: boolean) => {
      store.markChanged(id, fromHistory);
      onEdited(tab.documentId);
    },
    [store, id, onEdited, tab.documentId],
  );
  const currentPath = useRef(path);
  currentPath.current = path;
  const dialect = useDialect(wikilinkFolder !== null);
  const t = useT();
  const settings = useSettingsStore();
  const { proofreading, proofreadingModel } = useSettings().settings;
  const editor = store.editor(id);
  const canProofread =
    active &&
    !settingsOpen &&
    !tab.external &&
    (path === null || isDocumentPath(path)) &&
    proofreading &&
    proofreadingModel;
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
    async (link: LinkTarget) => {
      if (link.kind === "external") {
        void platform.openExternal(link.url);
      } else if (!link.path && link.fragment) {
        store.revealHeading(id, link.fragment);
      } else {
        const result = await resolveDocumentLink(platform, wikilinkFolder, path, link, t);
        if ("error" in result) onLinkError(result.error);
        else if (result.path && isAbsolutePath(result.path)) {
          void store.openDocument(
            result.path,
            link.fragment ? { fragment: link.fragment } : undefined,
          );
        }
      }
    },
    [platform, store, path, id, wikilinkFolder, onLinkError, t],
  );
  return (
    <div
      ref={panel}
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!visible}
      style={{ gridColumn: tab.pane === "primary" ? 1 : 2, gridRow: 1 }}
      onFocus={() => {
        if (!active) store.activate(id);
      }}
      className="flex min-w-0 min-h-0 h-full flex-col"
    >
      {preview && active && (
        <LinkPreview
          key={JSON.stringify(preview)}
          wikilinkFolder={wikilinkFolder}
          source={tab}
          link={preview}
          platform={platform}
          onClose={() => {
            setPreview(null);
            store.editor(id)?.focus();
          }}
        />
      )}
      <ExternalChangeNotice tab={tab} />
      {imageFailure && (
        <ImageSaveNotice failure={imageFailure} onDismiss={() => setImageFailure(null)} />
      )}
      {drafting}
      {editor && canProofread && (
        <Proofreading
          key={proofreadingModel}
          editor={editor}
          platform={platform}
          modelId={proofreadingModel}
        />
      )}
      <div
        className={`flex min-h-0 min-w-0 flex-1 ${toolbarPosition === "side" ? "flex-row" : "flex-col"}`}
      >
        {toolbarPosition !== "hidden" && <FormattingToolbar tab={tab} position={toolbarPosition} />}
        <WritingAssistant
          editor={editor}
          name={tabName(t, tab)}
          tabId={id}
          path={path}
          active={active}
          platform={platform}
          folder={folder}
          askRequest={askWriting}
          taskRestore={writingTaskRestore}
          taskListRevision={writingTaskListRevision}
          settingsOpen={settingsOpen}
          onAsk={onAskWriting}
          onTasks={onWritingTasks}
          onActivate={activate}
          onSettings={onOpenSettings}
          externalChange={!!tab.external}
          refreshDisk={() => store.refreshDisk(id)}
        >
          <EditorPane
            codeBlockRenderers={codeBlockRenderers}
            text={tab.text}
            document={tab.document}
            active={active}
            onReady={onReady}
            onChange={onChange}
            onModeChange={onModeChange}
            onOpenLink={onOpenLink}
            onPreviewLink={(link) => {
              store.activate(id);
              setPreview(link);
            }}
            writeClipboardText={platform.writeClipboardText}
            imageHost={imageHost}
            onWordCount={onWordCount}
            dialect={dialect}
          />
        </WritingAssistant>
      </div>
    </div>
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
