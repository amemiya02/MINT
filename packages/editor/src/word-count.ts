import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

/** How long the document is, as returned by {@link MintEditor.getWordCount}. */
export interface WordCount {
  /**
   * Words of the text as rendered (Markdown markers, link targets and front
   * matter left out). Each Chinese or Japanese character counts as a word;
   * elsewhere a word is a run of letters and digits, kept whole across
   * apostrophes, hyphens and decimal points.
   */
  readonly words: number;
  /** Characters of the same text, whitespace excluded. */
  readonly characters: number;
  /** Estimated reading time in whole minutes, rounded up: 300 Chinese/Japanese characters or 200 other words a minute. */
  readonly readingMinutes: number;
}

/** Nodes whose whole text is not part of the rendered document. */
const hiddenNodes = new Set([
  "FrontMatter",
  "LinkReference",
  "CodeInfo",
  "LinkTitle",
  "LinkLabel",
  "TaskMarker",
  "HorizontalRule",
]);
/** A URL is hidden behind the text of these; bare and `<…>` autolinks show it. */
const urlHiders = new Set(["Link", "Image"]);

const ideograph = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const word = /[\p{L}\p{N}\p{M}]+(?:['’.-][\p{L}\p{N}\p{M}]+)*/gu;
const visible = /\S/gu;

const charactersPerMinute = 300;
const wordsPerMinute = 200;

/** The rendered text of the document: every hidden range replaced by a space. */
function renderedText(state: EditorState): string {
  const tree = ensureSyntaxTree(state, state.doc.length, 1000) ?? syntaxTree(state);
  const parts: string[] = [];
  let pos = 0;
  tree.iterate({
    enter(node) {
      const hidden =
        hiddenNodes.has(node.name) ||
        node.name.endsWith("Mark") ||
        (node.name === "URL" && urlHiders.has(node.node.parent?.name ?? ""));
      if (!hidden) return true;
      if (node.from > pos) parts.push(state.sliceDoc(pos, node.from));
      parts.push(" ");
      pos = Math.max(pos, node.to);
      return false;
    },
  });
  parts.push(state.sliceDoc(pos));
  return parts.join("");
}

export function countWords(state: EditorState): WordCount {
  const text = renderedText(state);
  const ideographs = text.match(ideograph)?.length ?? 0;
  const others = text.replace(ideograph, " ").match(word)?.length ?? 0;
  const characters = text.match(visible)?.length ?? 0;
  const minutes = ideographs / charactersPerMinute + others / wordsPerMinute;
  return { words: ideographs + others, characters, readingMinutes: Math.ceil(minutes) };
}
