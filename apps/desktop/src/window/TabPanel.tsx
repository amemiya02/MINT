import type { LinkTarget, WordCount } from "@mint/editor";
import { useCallback, useRef, useState } from "react";
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

/** Every open tab keeps its editor mounted, so undo history and selection survive switching. */
export function TabPanel({
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
          writeClipboardText={platform.writeClipboardText}
          imageHost={imageHost}
          onWordCount={onWordCount}
          dialect={dialect}
        />
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
