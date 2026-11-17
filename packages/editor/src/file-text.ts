import { invertedEffects } from "@codemirror/commands";
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  Text,
  type Transaction,
} from "@codemirror/state";

/**
 * The editor's document is the file text with two things lifted out of it,
 * so that CodeMirror only ever sees plain `\n`-separated lines:
 *
 * - a leading UTF-8 byte order mark, and
 * - the exact terminator (`\n`, `\r\n` or `\r`) of every line break.
 *
 * Both are restored by {@link fileText}, which guarantees source fidelity:
 * text the user did not edit comes back byte for byte, including mixed line
 * endings. New line breaks get the file's dominant terminator.
 */

const BOM = "﻿";
const LINE_BREAK = /\r\n|\r|\n/g;

interface LineEndings {
  readonly bom: boolean;
  /** Terminator used for line breaks the user types. */
  readonly fallback: string;
  /** Terminator after each line (index 0 = after line 1); `null` when every break uses `fallback`. */
  readonly breaks: readonly string[] | null;
}

export interface ParsedFileText {
  readonly doc: Text;
  readonly extension: Extension;
}

export function parseFileText(raw: string): ParsedFileText {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  const lines: string[] = [];
  const breaks: string[] = [];
  let start = 0;
  for (const match of body.matchAll(LINE_BREAK)) {
    lines.push(body.slice(start, match.index));
    breaks.push(match[0]);
    start = match.index + match[0].length;
  }
  lines.push(body.slice(start));

  const fallback = dominant(breaks);
  const uniform = breaks.every((b) => b === fallback);
  const endings: LineEndings = { bom, fallback, breaks: uniform ? null : breaks };
  return { doc: Text.of(lines), extension: lineEndingsField.init(() => endings) };
}

/** The full file text: what should be written to disk. */
export function fileText(state: EditorState): string {
  const { bom, fallback, breaks } = state.field(lineEndingsField);
  const prefix = bom ? BOM : "";
  if (!breaks) return prefix + state.doc.sliceString(0, state.doc.length, fallback);
  const parts: string[] = [prefix];
  for (let n = 1; n <= state.doc.lines; n++) {
    parts.push(state.doc.line(n).text);
    if (n < state.doc.lines) parts.push(breaks[n - 1] ?? fallback);
  }
  return parts.join("");
}

/** Convert an editor position to an offset in {@link fileText}. */
export function toFileOffset(state: EditorState, pos: number): number {
  const { bom, breaks, fallback } = state.field(lineEndingsField);
  const line = state.doc.lineAt(pos);
  let extra = 0;
  for (let i = 0; i < line.number - 1; i++) extra += (breaks?.[i] ?? fallback).length - 1;
  return (bom ? 1 : 0) + pos + extra;
}

/** Convert an offset in {@link fileText} to an editor position (offsets inside a CRLF snap to the line end). */
export function fromFileOffset(state: EditorState, offset: number): number {
  const { bom, breaks, fallback } = state.field(lineEndingsField);
  let remaining = Math.max(0, offset - (bom ? 1 : 0));
  for (let n = 1; ; n++) {
    const line = state.doc.line(n);
    if (remaining <= line.length || n === state.doc.lines)
      return line.from + Math.min(remaining, line.length);
    const terminator = breaks?.[n - 1] ?? fallback;
    if (remaining < line.length + terminator.length) return line.to;
    remaining -= line.length + terminator.length;
  }
}

function dominant(breaks: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const b of breaks) counts.set(b, (counts.get(b) ?? 0) + 1);
  let best = "\n";
  let bestCount = 0;
  for (const [b, count] of counts) {
    if (count > bestCount) {
      best = b;
      bestCount = count;
    }
  }
  return best;
}

// Undo must bring back the original terminators of line breaks it restores,
// so transactions that delete breaks from a mixed-ending document record a
// snapshot that the inverse (undo/redo) transaction reinstates.
interface Snapshot {
  readonly seq: number;
  readonly breaks: readonly string[];
}
const restoreBreaks = StateEffect.define<Snapshot>();
let snapshotSeq = 0;

const lineEndingsField: StateField<LineEndings> = StateField.define<LineEndings>({
  create: () => ({ bom: false, fallback: "\n", breaks: null }),
  update(value, tr) {
    const restored = earliestSnapshot(tr);
    if (restored && restored.breaks.length === tr.newDoc.lines - 1) {
      return { ...value, breaks: restored.breaks };
    }
    if (!tr.docChanged || !value.breaks) return value;
    return { ...value, breaks: mapBreaks(value.breaks, value.fallback, tr) };
  },
  provide: () =>
    invertedEffects.of((tr) => {
      const { breaks } = tr.startState.field(lineEndingsField);
      if (!breaks || !removesLineBreak(tr)) return [];
      return [restoreBreaks.of({ seq: ++snapshotSeq, breaks })];
    }),
});

function earliestSnapshot(tr: Transaction): Snapshot | undefined {
  let found: Snapshot | undefined;
  for (const effect of tr.effects) {
    if (effect.is(restoreBreaks) && (!found || effect.value.seq < found.seq)) found = effect.value;
  }
  return found;
}

function removesLineBreak(tr: Transaction): boolean {
  let removes = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (tr.startState.doc.lineAt(fromA).number !== tr.startState.doc.lineAt(toA).number)
      removes = true;
  });
  return removes;
}

function mapBreaks(breaks: readonly string[], fallback: string, tr: Transaction): string[] {
  const edits: { at: number; removed: number; added: number }[] = [];
  const startDoc = tr.startState.doc;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const startLine = startDoc.lineAt(fromA).number;
    const endLine = startDoc.lineAt(toA).number;
    edits.push({ at: startLine - 1, removed: endLine - startLine, added: inserted.lines - 1 });
  });
  const next = [...breaks];
  for (const edit of edits.reverse()) {
    next.splice(edit.at, edit.removed, ...Array<string>(edit.added).fill(fallback));
  }
  return next;
}
