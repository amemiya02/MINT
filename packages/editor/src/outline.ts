import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import { headingLevel } from "./live-preview/headings.ts";
import { urlOwners } from "./live-preview/inline-spans.ts";

/** One heading of the {@link MintEditor.getOutline outline}. */
export interface OutlineHeading {
  /** 1–6. */
  readonly level: number;
  /** The heading's text as rendered: Markdown markers removed, whitespace collapsed. */
  readonly text: string;
  /** Where the heading starts, in `getText()` offsets. */
  readonly from: number;
}

/** Blocks that hold headings; every other block is skipped without looking inside. */
const containers = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

/** Headings in document order, positions in editor (not file) offsets. */
export function outline(state: EditorState, complete: boolean): OutlineHeading[] {
  const tree: Tree =
    (complete ? ensureSyntaxTree(state, state.doc.length, 1000) : null) ?? syntaxTree(state);
  const headings: OutlineHeading[] = [];
  tree.iterate({
    enter(ref) {
      const level = headingLevel(ref.name);
      if (level) {
        headings.push({ level, text: headingText(state, ref.node), from: ref.from });
        return false;
      }
      return containers.has(ref.name);
    },
  });
  return headings;
}

function headingText(state: EditorState, heading: SyntaxNode): string {
  const marks = heading.getChildren("HeaderMark");
  let from = heading.from;
  let to = heading.to;
  if (heading.name.startsWith("ATX")) {
    const [open, close] = marks;
    if (open) from = open.to;
    if (close && close.from > from) to = close.from;
  } else {
    const underline = marks[marks.length - 1];
    if (underline) to = state.doc.lineAt(underline.from).from;
  }

  // Drop markers and link destinations, keep what live preview shows.
  let text = "";
  let pos = from;
  heading.toTree().iterate({
    from: from - heading.from,
    to: to - heading.from,
    enter(ref) {
      const name = ref.name;
      const hidden =
        name.endsWith("Mark") ||
        name === "LinkTitle" ||
        name === "LinkLabel" ||
        (name === "URL" && urlOwners.has(ref.node.parent?.name ?? ""));
      if (!hidden) return;
      const start = Math.max(from, heading.from + ref.from);
      const end = Math.min(to, heading.from + ref.to);
      if (start > pos) text += state.sliceDoc(pos, start);
      pos = Math.max(pos, end);
      return false;
    },
  });
  if (to > pos) text += state.sliceDoc(pos, to);
  return text.replace(/\s+/g, " ").trim();
}

export function sameOutline(a: readonly OutlineHeading[], b: readonly OutlineHeading[]): boolean {
  return (
    a.length === b.length &&
    a.every((h, i) => {
      const other = b[i];
      return other && h.level === other.level && h.text === other.text && h.from === other.from;
    })
  );
}
