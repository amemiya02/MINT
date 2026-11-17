import { createEditor, type LinkTarget, type MintEditor } from "@mint/editor";
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
}

/** Mounts the framework-agnostic editor core into React. */
export function EditorPane({
  text,
  active,
  onReady,
  onChange,
  onModeChange,
  onOpenLink,
  imageHost,
}: EditorPaneProps) {
  const parent = useRef<HTMLDivElement>(null);
  const { settings } = useSettings();
  const { vimMode: vim, spellcheck } = settings;
  // Taken when the editor is created; later changes are applied by the effect below.
  const preferences = useRef({ vim, spellcheck });
  preferences.current = { vim, spellcheck };
  const editor = useRef<MintEditor | null>(null);
  const callbacks = useRef({ onReady, onChange, onModeChange, onOpenLink, imageHost });
  callbacks.current = { onReady, onChange, onModeChange, onOpenLink, imageHost };

  useEffect(() => {
    if (!parent.current) return;
    const instance = createEditor({
      parent: parent.current,
      text,
      ...preferences.current,
      host: {
        openLink: (link) => callbacks.current.onOpenLink(link),
        resolveImageUrl: (path) => callbacks.current.imageHost.resolveImageUrl(path),
        saveImage: (file) => callbacks.current.imageHost.saveImage(file),
      },
    });
    const unsubscribe = instance.subscribe((event) => {
      if (event.type === "change") callbacks.current.onChange();
      if (event.type === "mode") callbacks.current.onModeChange();
    });
    editor.current = instance;
    callbacks.current.onReady(instance);
    return () => {
      unsubscribe();
      callbacks.current.onReady(null);
      editor.current = null;
      instance.destroy();
    };
  }, [text]);

  useEffect(() => {
    editor.current?.configure({ vim, spellcheck });
  }, [vim, spellcheck]);

  useEffect(() => {
    if (active) editor.current?.focus();
  }, [active]);

  return <div ref={parent} className="mint-editor h-full" />;
}
