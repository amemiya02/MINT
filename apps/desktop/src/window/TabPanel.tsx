import type { DocumentLink, LinkTarget, WordCount } from "@mint/editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { createImageHost, type ImageSaveFailure } from "../assets/image-host.ts";
import { EditorPane } from "../EditorPane.tsx";
import { useT } from "../i18n/index.ts";
import { isAbsolutePath, resolveFrom } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { useDialect } from "../settings/useDialect.ts";
import { useSettingsStore } from "../settings/useSettings.ts";
import { useTabStore } from "../tabs/context.ts";
import { ExternalChangeNotice } from "../tabs/ExternalChangeNotice.tsx";
import type { Tab, TabStore } from "../tabs/tab-store.ts";
import { FormattingToolbar, type ToolbarPosition } from "./FormattingToolbar.tsx";

import { LinkPreview } from "./LinkPreview.tsx";

/** Every open tab keeps its editor mounted, so undo history and selection survive switching. */
export function TabPanel({
  tab,
  active,
  visible,
  toolbarPosition,
  platform,
  onModeChange,
  onEditorChange,
  onEdited,
  onWordCount,
}: {
  readonly tab: Tab;
  readonly active: boolean;
  readonly visible: boolean;
  readonly toolbarPosition: ToolbarPosition;
  readonly platform: Platform;
  readonly onModeChange: () => void;
  /** The tab's editor was created or destroyed. */
  readonly onEditorChange: () => void;
  readonly onEdited: (id: number) => void;
  readonly onWordCount: (count: WordCount) => void;
}) {
  const store = useTabStore();
  const { id, path } = tab;
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
      if (link.kind === "external") {
        void platform.openExternal(link.url);
      } else if (!link.path && link.fragment) {
        store.revealHeading(id, link.fragment);
      } else {
        const target = path ? resolveFrom(path, link.path) : link.path;
        if (isAbsolutePath(target)) {
          void store.openDocument(target, link.fragment ? { fragment: link.fragment } : undefined);
        }
      }
    },
    [platform, store, path, id],
  );
  return (
    <div
      ref={panel}
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!visible}
      style={{ gridColumn: tab.pane === "primary" ? 1 : 2, gridRow: 1 }}
      onFocusCapture={() => {
        if (!active) store.activate(id);
      }}
      className="flex min-w-0 min-h-0 h-full flex-col"
    >
      {preview && active && (
        <LinkPreview
          key={JSON.stringify(preview)}
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
      <div
        className={`flex min-h-0 min-w-0 flex-1 ${toolbarPosition === "side" ? "flex-row" : "flex-col"}`}
      >
        {toolbarPosition !== "hidden" && <FormattingToolbar tab={tab} position={toolbarPosition} />}
        <div className="min-h-0 min-w-0 flex-1">
          <EditorPane
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
        </div>
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
