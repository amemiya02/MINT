import { createEditor, type MintEditor } from "@mint/editor";
import { useEffect, useRef } from "react";

interface EditorPaneProps {
  /** Initial file text. The editor is recreated only when the pane is remounted (use a `key`). */
  readonly text: string;
  /** Whether the pane is the one on screen; it takes focus when it becomes active. */
  readonly active: boolean;
  readonly onReady: (editor: MintEditor | null) => void;
  readonly onChange: () => void;
}

/** Mounts the framework-agnostic editor core into React. */
export function EditorPane({ text, active, onReady, onChange }: EditorPaneProps) {
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<MintEditor | null>(null);
  const callbacks = useRef({ onReady, onChange });
  callbacks.current = { onReady, onChange };

  useEffect(() => {
    if (!parent.current) return;
    const instance = createEditor({ parent: parent.current, text });
    const unsubscribe = instance.subscribe((event) => {
      if (event.type === "change") callbacks.current.onChange();
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
    if (active) editor.current?.focus();
  }, [active]);

  return <div ref={parent} className="mint-editor h-full" />;
}
