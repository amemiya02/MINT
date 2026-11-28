import type { MintEditor } from "@mint/editor";

export interface WritingSelection {
  readonly editor: MintEditor;
  readonly text: string;
  readonly range: ReturnType<MintEditor["trackRange"]>;
}

export function captureWritingSelection(editor: MintEditor): WritingSelection | null {
  const { anchor, head } = editor.getSelection();
  if (anchor === head) return null;
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  return {
    editor,
    text: editor.getText().slice(from, to),
    range: editor.trackRange({ from, to }),
  };
}

export function applyWritingSelection(
  origin: WritingSelection,
  replacement: string,
  canApply: boolean,
) {
  const range = origin.range.current();
  const current = origin.editor.getText().slice(range.from, range.to);
  if (!canApply || current !== origin.text) return { status: "conflict", current } as const;
  if (replacement !== origin.text) origin.editor.replaceRange(range, replacement);
  return { status: "applied" } as const;
}
