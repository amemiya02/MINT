import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { fileText, toFileOffset } from "./file-text.ts";

export interface ProsePassage {
  /** Offset in the file text, including its original line endings and any BOM. */
  readonly from: number;
  readonly text: string;
}

/** A bounded run of prose at the cursor, stopping at inline Markdown constructs. */
export function prosePassageAtCursor(state: EditorState): ProsePassage | null {
  const { head } = state.selection.main;
  const line = state.doc.lineAt(head);
  let paragraph = syntaxTree(state).resolveInner(head, head === line.from ? 1 : -1);
  while (paragraph.name !== "Paragraph") {
    if (!paragraph.parent) return null;
    paragraph = paragraph.parent;
  }

  let { from, to } = paragraph;
  for (let child = paragraph.firstChild; child; child = child.nextSibling) {
    if (child.to <= head) from = child.to;
    else if (child.from >= head) {
      to = child.from;
      break;
    } else return null;
  }
  if (to - from > 2000 || from === to) return null;
  const offset = toFileOffset(state, from);
  const source = fileText(state).slice(offset, toFileOffset(state, to));
  const text = source.trim();
  return /\p{L}/u.test(text)
    ? { from: offset + source.length - source.trimStart().length, text }
    : null;
}
