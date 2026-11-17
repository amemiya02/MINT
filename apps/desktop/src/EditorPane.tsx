import {
  createEditor,
  type EditorSettings,
  type LinkTarget,
  type MintEditor,
  type WordCount,
} from "@mint/editor";
import { useEffect, useRef } from "react";
import type { ImageHost } from "./assets/image-host.ts";
import { useSettings } from "./settings/useSettings.ts";

interface EditorPaneProps {
  /** Initial file text. The editor is recreated only when the pane is remounted (use a `key`). */
  readonly text: string;
  /** Whether the pane is the one on screen; it takes focus when it becomes active. */
  readonly active: boolean;
  readonly onReady: (editor: MintEditor | null) => void;
  readonly onChange: () => void;
  readonly onModeChange: () => void;
  /** The user ⌘-clicked a link. */
  readonly onOpenLink: (link: LinkTarget) => void;
  /** Resolves and saves the document's images. */
  readonly imageHost: ImageHost;
  /** The document's word count, reported while the pane is active: on activation and shortly after edits. */
  readonly onWordCount: (count: WordCount) => void;
}

/** How long typing must pause before the word count is refreshed; counting reads the whole document. */
const wordCountDelay = 150;

/** Mounts the framework-agnostic editor core into React. */
export function EditorPane({
  text,
  active,
  onReady,
  onChange,
  onModeChange,
  onOpenLink,
  imageHost,
  onWordCount,
}: EditorPaneProps) {
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<MintEditor | null>(null);
  const { settings } = useSettings();
  const editorSettings: EditorSettings = {
    focusMode: settings.focusMode,
    typewriterMode: settings.typewriterMode,
  };
  const callbacks = useRef({
    onReady,
    onChange,
    onModeChange,
    onOpenLink,
    imageHost,
    onWordCount,
    active,
    editorSettings,
  });
  callbacks.current = {
    onReady,
    onChange,
    onModeChange,
    onOpenLink,
    imageHost,
    onWordCount,
    active,
    editorSettings,
  };

  useEffect(() => {
    if (!parent.current) return;
    const instance = createEditor({
      parent: parent.current,
      text,
      settings: callbacks.current.editorSettings,
      host: {
        openLink: (link) => callbacks.current.onOpenLink(link),
        resolveImageUrl: (path) => callbacks.current.imageHost.resolveImageUrl(path),
        saveImage: (file) => callbacks.current.imageHost.saveImage(file),
      },
    });
    let countTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = instance.subscribe((event) => {
      if (event.type === "change") {
        callbacks.current.onChange();
        clearTimeout(countTimer);
        countTimer = setTimeout(() => {
          if (callbacks.current.active) callbacks.current.onWordCount(instance.getWordCount());
        }, wordCountDelay);
      }
      if (event.type === "mode") callbacks.current.onModeChange();
    });
    editor.current = instance;
    callbacks.current.onReady(instance);
    if (callbacks.current.active) callbacks.current.onWordCount(instance.getWordCount());
    return () => {
      clearTimeout(countTimer);
      unsubscribe();
      callbacks.current.onReady(null);
      editor.current = null;
      instance.destroy();
    };
  }, [text]);

  useEffect(() => {
    if (!active || !editor.current) return;
    editor.current.focus();
    callbacks.current.onWordCount(editor.current.getWordCount());
  }, [active]);

  const { focusMode, typewriterMode } = editorSettings;
  useEffect(() => {
    editor.current?.updateSettings({ focusMode, typewriterMode });
  }, [focusMode, typewriterMode]);

  return <div ref={parent} className="mint-editor h-full" />;
}
