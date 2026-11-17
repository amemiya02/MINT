import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Line,
  type SelectionRange,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";

/**
 * Formatting commands: the paragraph and inline formats behind Typora's default
 * shortcuts. Each one is a minimal text change confined to what it formats, so
 * source fidelity holds for the rest of the document.
 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface FormattingCommands {
  /**
   * Make the lines of the selection headings of `level`. Lines that already are
   * headings of that level become paragraphs again (Typora's toggle).
   */
  setHeading: [level: HeadingLevel];
  /** Make the heading lines of the selection paragraphs. */
  setParagraph: [];
  /** Wrap the selection in `**`, or remove the strong emphasis around it. */
  toggleBold: [];
  /** Wrap the selection in `*`, or remove the emphasis around it. */
  toggleItalic: [];
  /**
   * Make the selection the text of a link and put the cursor where the URL goes;
   * inside a link, remove the link and keep its text.
   */
  toggleLink: [];
  /** Put the lines of the selection (or an empty line) in a fenced code block. */
  insertCodeBlock: [];
}

/** Nodes whose content is literal: no formatting applies inside them. */
const literalBlocks = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock"]);

function tree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
}

interface LineInfo {
  readonly line: Line;
  /** Where the line's own content starts, after block quote and list markers. */
  readonly contentFrom: number;
  readonly literal: boolean;
}

function lineInfo(state: EditorState, syntax: Tree, line: Line): LineInfo {
  let markEnd = line.from;
  let literal = false;
  syntax.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (literalBlocks.has(node.name) && node.from < line.to + 1 && node.to > line.from) {
        literal = true;
      }
      if ((node.name === "QuoteMark" || node.name === "ListMark") && node.from >= line.from) {
        markEnd = Math.max(markEnd, node.to);
      }
    },
  });
  const rest = state.sliceDoc(markEnd, line.to);
  const contentFrom = markEnd + (rest.length - rest.trimStart().length);
  return { line, contentFrom, literal };
}

/** The distinct lines touched by the selection, in document order. */
function selectedLines(state: EditorState): Line[] {
  const lines = new Map<number, Line>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    // A selection ending at the start of a line does not include that line.
    const endLine = state.doc.lineAt(range.to);
    const last =
      range.to > range.from && endLine.from === range.to ? endLine.number - 1 : endLine.number;
    for (let n = first; n <= Math.max(first, last); n++) lines.set(n, state.doc.line(n));
  }
  return [...lines.values()].sort((a, b) => a.number - b.number);
}

const atxMarker = /^(#{1,6})(?=[ \t]|$)[ \t]*/;
const closingSequence = /[ \t]+#+[ \t]*$/;

interface HeadingAt {
  readonly level: HeadingLevel;
  /** Change that removes the heading syntax, leaving a paragraph. */
  readonly remove: ChangeSpec[];
  /** Change that removes only the level marker; prefix for the new marker goes at `markerAt`. */
  readonly replaceMarker: ChangeSpec[];
  readonly markerAt: number;
}

function setextHeading(syntax: Tree, info: LineInfo): SyntaxNode | null {
  for (
    let node: SyntaxNode | null = syntax.resolveInner(info.contentFrom, 1);
    node;
    node = node.parent
  ) {
    if (node.name === "SetextHeading1" || node.name === "SetextHeading2") return node;
  }
  return null;
}

function headingAt(state: EditorState, syntax: Tree, info: LineInfo): HeadingAt | null {
  const text = state.sliceDoc(info.contentFrom, info.line.to);
  const atx = atxMarker.exec(text);
  if (atx) {
    const markerTo = info.contentFrom + atx[0].length;
    const closing = closingSequence.exec(state.sliceDoc(markerTo, info.line.to));
    const remove: ChangeSpec[] = [{ from: info.contentFrom, to: markerTo }];
    if (closing) remove.push({ from: markerTo + closing.index, to: info.line.to });
    return {
      level: (atx[1] as string).length as HeadingLevel,
      remove,
      replaceMarker: [{ from: info.contentFrom, to: markerTo }],
      markerAt: info.contentFrom,
    };
  }
  const setext = setextHeading(syntax, info);
  if (setext) {
    const underline = state.doc.lineAt(setext.to);
    const removeUnderline = { from: state.doc.line(underline.number - 1).to, to: underline.to };
    const first = lineInfo(state, syntax, state.doc.lineAt(setext.from));
    return {
      level: setext.name === "SetextHeading1" ? 1 : 2,
      remove: [removeUnderline],
      replaceMarker: [removeUnderline],
      markerAt: first.contentFrom,
    };
  }
  return null;
}

function headingCommand(view: EditorView, level: HeadingLevel | null): boolean {
  const { state } = view;
  const syntax = tree(state);
  const targets = selectedLines(state)
    .map((line) => lineInfo(state, syntax, line))
    // The underline of a setext heading belongs to the heading's text line.
    .filter((info) => !info.literal && !isSetextUnderline(syntax, info))
    .map((info) => ({ info, heading: headingAt(state, syntax, info) }));
  if (targets.length === 0) return false;
  const toggleOff = level !== null && targets.every(({ heading }) => heading?.level === level);
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const { info, heading } of targets) {
    if (heading) {
      if (seen.has(heading.markerAt)) continue;
      seen.add(heading.markerAt);
    }
    if (level === null || toggleOff) {
      if (heading) changes.push(...heading.remove);
    } else if (heading) {
      if (heading.level === level) continue;
      changes.push(...heading.replaceMarker, { from: heading.markerAt, insert: marker(level) });
    } else {
      changes.push({ from: info.contentFrom, insert: marker(level) });
    }
  }
  if (changes.length === 0) return false;
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet, 1),
    userEvent: "input.format",
    scrollIntoView: true,
  });
  return true;
}

function marker(level: HeadingLevel): string {
  return `${"#".repeat(level)} `;
}

function isSetextUnderline(syntax: Tree, info: LineInfo): boolean {
  const node = syntax.resolveInner(info.contentFrom, 1);
  return node.name === "HeaderMark" && node.parent?.name.startsWith("SetextHeading") === true;
}

/** The innermost `name` node containing the whole range, if any. */
function enclosing(syntax: Tree, range: SelectionRange, name: string): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    const pos = side === 1 ? range.from : range.to;
    for (let node: SyntaxNode | null = syntax.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === name && node.from <= range.from && node.to >= range.to) return node;
    }
  }
  return null;
}

function toggleInline(view: EditorView, nodeName: string, mark: string): boolean {
  const { state } = view;
  const syntax = tree(state);
  const size = mark.length;
  view.dispatch(
    state.changeByRange((range) => {
      const node = enclosing(syntax, range, nodeName);
      if (node) {
        // Remove the emphasis marks at both ends of the node.
        const changes = [
          { from: node.from, to: node.from + size },
          { from: node.to - size, to: node.to },
        ];
        const set = state.changes(changes);
        return {
          changes,
          range: EditorSelection.range(set.mapPos(range.anchor, 1), set.mapPos(range.head, -1)),
        };
      }
      // An empty pair left by a previous toggle (`**|**`) is removed again.
      if (
        range.empty &&
        state.sliceDoc(range.from - size, range.from) === mark &&
        state.sliceDoc(range.from, range.from + size) === mark
      ) {
        return {
          changes: { from: range.from - size, to: range.from + size },
          range: EditorSelection.cursor(range.from - size),
        };
      }
      return {
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        range: EditorSelection.range(range.anchor + size, range.head + size),
      };
    }),
    { userEvent: "input.format", scrollIntoView: true },
  );
  return true;
}

function toggleLink(view: EditorView): boolean {
  const { state } = view;
  const syntax = tree(state);
  view.dispatch(
    state.changeByRange((range) => {
      const link = enclosing(syntax, range, "Link");
      if (link) {
        // Keep the link text: drop `[` and everything from `]` on.
        const marks = link.getChildren("LinkMark");
        const open = marks[0];
        const close = marks[1];
        if (open && close) {
          const changes = [
            { from: open.from, to: open.to },
            { from: close.from, to: link.to },
          ];
          const set = state.changes(changes);
          const clamp = (pos: number) => Math.min(set.mapPos(pos, -1), set.mapPos(close.from, -1));
          return { changes, range: EditorSelection.range(clamp(range.anchor), clamp(range.head)) };
        }
      }
      const text = state.sliceDoc(range.from, range.to);
      // Without text, the cursor goes between the brackets; with text, between the parentheses.
      const cursor = range.empty ? range.from + 1 : range.from + text.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert: `[${text}]()` },
        range: EditorSelection.cursor(cursor),
      };
    }),
    { userEvent: "input.format", scrollIntoView: true },
  );
  return true;
}

function insertCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const syntax = tree(state);
  const range = state.selection.main;
  const first = lineInfo(state, syntax, state.doc.lineAt(range.from));
  const lines = selectedLines(state).filter((l) => l.number >= first.line.number);
  const last = lines[lines.length - 1] ?? first.line;
  // Continuation lines repeat the block quote markers; list markers become indentation.
  const prefix = state
    .sliceDoc(first.line.from, first.contentFrom)
    .replace(/[-*+]|\d+[.)]/g, (m) => " ".repeat(m.length));
  const empty = first.contentFrom === last.to;
  if (empty) {
    const insert = `\`\`\`\n${prefix}\n${prefix}\`\`\``;
    view.dispatch({
      changes: { from: first.contentFrom, to: last.to, insert },
      selection: EditorSelection.cursor(first.contentFrom + 4 + prefix.length),
      userEvent: "input.format",
      scrollIntoView: true,
    });
    return true;
  }
  const changes = state.changes([
    { from: first.contentFrom, insert: `\`\`\`\n${prefix}` },
    { from: last.to, insert: `\n${prefix}\`\`\`` },
  ]);
  view.dispatch({
    changes,
    selection: state.selection.map(changes, 1),
    userEvent: "input.format",
    scrollIntoView: true,
  });
  return true;
}

export function formattingCommands(view: EditorView): {
  [C in keyof FormattingCommands]: (...args: FormattingCommands[C]) => boolean;
} {
  return {
    setHeading: (level) => headingCommand(view, level),
    setParagraph: () => headingCommand(view, null),
    toggleBold: () => toggleInline(view, "StrongEmphasis", "**"),
    toggleItalic: () => toggleInline(view, "Emphasis", "*"),
    toggleLink: () => toggleLink(view),
    insertCodeBlock: () => insertCodeBlock(view),
  };
}
