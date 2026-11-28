import {
  type CodeBlockRenderer,
  createEditor,
  type DocumentLink,
  type EditorDialect,
  type EditorSettings,
  type LinkTarget,
  type MintEditor,
  type SharedDocument,
  type WordCount,
} from "@mint/editor";
import { useEffect, useRef } from "react";
import type { ImageHost } from "./assets/image-host.ts";
import { editorPhrases } from "./editor-phrases.ts";
import { useT } from "./i18n/index.ts";
import { useSettings } from "./settings/useSettings.ts";

interface EditorPaneProps {
  /** Initial file text. The editor is recreated only when the pane is remounted (use a `key`). */
  readonly text: string;
  readonly codeBlockRenderers: readonly CodeBlockRenderer[];
  readonly document: SharedDocument;
  /** Whether this editor reports the active document’s word count. */
  readonly active: boolean;
  readonly onReady: (editor: MintEditor | null) => void;
  readonly onChange: (fromHistory: boolean) => void;
  readonly onModeChange: () => void;
  /** The user ⌘-clicked a link. */
  readonly onOpenLink: (link: LinkTarget) => void;
  readonly onPreviewLink: (link: DocumentLink) => void;
  readonly writeClipboardText: (text: string) => Promise<void>;
  /** Resolves and saves the document's images. */
  readonly imageHost: ImageHost;
  /** The document's word count, reported while the pane is active: on activation and shortly after edits. */
  readonly onWordCount: (count: WordCount) => void;
  /** The syntax to recognise; a change applies to the open editor at once. */
  readonly dialect: EditorDialect;
}

/** How long typing must pause before the word count is refreshed; counting reads the whole document. */
const wordCountDelay = 150;

/** Mounts the framework-agnostic editor core into React. */
export function EditorPane({
  text,
  document,
  codeBlockRenderers,
  active,
  onReady,
  onChange,
  onModeChange,
  onOpenLink,
  onPreviewLink,
  writeClipboardText,
  imageHost,
  onWordCount,
  dialect,
}: EditorPaneProps) {
  const parent = useRef<HTMLDivElement>(null);
  const t = useT();
  // Taken when the editor is created; a language change applies to editors opened afterwards.
  const phrases = useRef<Record<string, string>>({});
  phrases.current = editorPhrases(t);
  const editor = useRef<MintEditor | null>(null);
  const { settings } = useSettings();
  const editorSettings: EditorSettings = {
    focusMode: settings.focusMode,
    typewriterMode: settings.typewriterMode,
    vim: settings.vimMode,
    spellcheck: settings.spellcheck,
  };
  const callbacks = useRef({
    onReady,
    onChange,
    onModeChange,
    onOpenLink,
    onPreviewLink,
    writeClipboardText,
    imageHost,
    onWordCount,
    active,
    editorSettings,
    dialect,
  });
  callbacks.current = {
    onReady,
    onChange,
    onModeChange,
    onOpenLink,
    onPreviewLink,
    writeClipboardText,
    imageHost,
    onWordCount,
    active,
    editorSettings,
    dialect,
  };

  useEffect(() => {
    if (!parent.current) return;
    const instance = createEditor({
      parent: parent.current,
      text,
      document,
      dialect: callbacks.current.dialect,
      phrases: phrases.current,
      settings: callbacks.current.editorSettings,
      host: {
        previewLink: (link) => callbacks.current.onPreviewLink(link),
        openLink: (link) => callbacks.current.onOpenLink(link),
        writeClipboardText: (text) => callbacks.current.writeClipboardText(text),
        resolveImageUrl: (path) => callbacks.current.imageHost.resolveImageUrl(path),
        saveImage: (file) => callbacks.current.imageHost.saveImage(file),
      },
    });
    let countTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = instance.subscribe((event) => {
      if (event.type === "change") {
        if (!event.remote) callbacks.current.onChange(event.fromHistory ?? false);
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
  }, [text, document]);

  useEffect(() => {
    if (!active || !editor.current) return;
    callbacks.current.onWordCount(editor.current.getWordCount());
  }, [active]);

  useEffect(() => {
    editor.current?.setDialect(dialect);
  }, [dialect]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text and document recreate the editor above.
  useEffect(() => {
    editor.current?.setCodeBlockRenderers(codeBlockRenderers);
  }, [codeBlockRenderers, text, document]);

  const { focusMode, typewriterMode, vim, spellcheck } = editorSettings;
  useEffect(() => {
    editor.current?.updateSettings({ focusMode, typewriterMode, vim, spellcheck });
  }, [focusMode, typewriterMode, vim, spellcheck]);

  return <div ref={parent} className="mint-editor h-full" />;
}
