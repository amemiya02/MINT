import { createEditor, type MintEditor } from "@mint/editor";
import { useEffect, useRef } from "react";

interface EditorPaneProps {
  /** Initial file text. The editor is recreated only when the pane is remounted (use a `key`). */
  readonly text: string;
  readonly onReady: (editor: MintEditor | null) => void;
  readonly onChange: () => void;
}

/** Mounts the framework-agnostic editor core into React. */
export function EditorPane({ text, onReady, onChange }: EditorPaneProps) {
  const parent = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onChange });
  callbacks.current = { onReady, onChange };

  useEffect(() => {
    if (!parent.current) return;
    const editor = createEditor({ parent: parent.current, text });
    const unsubscribe = editor.subscribe((event) => {
      if (event.type === "change") callbacks.current.onChange();
    });
    callbacks.current.onReady(editor);
    editor.focus();
    return () => {
      unsubscribe();
      callbacks.current.onReady(null);
      editor.destroy();
    };
  }, [text]);

  return <div ref={parent} className="mint-editor h-full" />;
}
