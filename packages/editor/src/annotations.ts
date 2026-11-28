import { syntaxTree } from "@codemirror/language";
import type { EditorState, Transaction } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { fileText, fromFileOffset, toFileOffset } from "./file-text.ts";
import { type CellAddress, type Table, tableAt } from "./table/table-source.ts";

export type AnnotationKind = "text" | "cell" | "formula" | "image";

/** The current target in file-text offsets, with context for reopening an edited document. */
interface AnnotationRange {
  readonly from: number;
  readonly source: string;
  readonly before: string;
  readonly after: string;
}

export interface AnnotationTarget {
  readonly kind: AnnotationKind;
  readonly excerpt: string;
  readonly range: AnnotationRange;
  /** A rendered empty cell can be implied by its table without a source segment. */
  readonly implicitColumn?: number;
}

export interface Annotation extends Omit<AnnotationTarget, "range"> {
  readonly id: string;
  readonly note: string;
  readonly resolved: boolean;
  readonly range: AnnotationRange | null;
}

function annotationRange(text: string, from: number, to: number): AnnotationRange {
  return {
    from,
    source: text.slice(from, to),
    before: text.slice(Math.max(0, from - 48), from),
    after: text.slice(to, to + 48),
  };
}

export function textTarget(state: EditorState, from: number, to: number): AnnotationTarget {
  const range = rangeInFile(state, from, to);
  return { kind: "text", excerpt: range.source, range };
}

function rangeInFile(state: EditorState, from: number, to: number): AnnotationRange {
  return annotationRange(fileText(state), toFileOffset(state, from), toFileOffset(state, to));
}

function objectKind(node: SyntaxNode): "image" | "formula" | null {
  if (node.name === "Image") return "image";
  if (node.name === "InlineMath" || node.name === "BlockMath") return "formula";
  return null;
}

function objectAt(state: EditorState, from: number, to: number) {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(from, side); node; node = node.parent) {
      const kind = objectKind(node);
      if (kind && node.from <= from && to <= node.to) return { kind, from: node.from, to: node.to };
    }
  }
  return null;
}

export function markdownTarget(state: EditorState, from: number, to: number) {
  const object = objectAt(state, from, to);
  if (!object) return null;
  const range = rangeInFile(state, object.from, object.to);
  return { kind: object.kind, excerpt: range.source, range };
}

export function cellTarget(
  state: EditorState,
  table: Table,
  address: CellAddress,
): AnnotationTarget | null {
  const row = table.rows[address.row];
  if (!row) return null;
  const cell = row.cells[address.column];
  return {
    kind: "cell",
    excerpt: cell?.text ?? "",
    range: rangeInFile(state, cell?.from ?? row.to, cell?.to ?? row.to),
    ...(cell ? {} : { implicitColumn: address.column }),
  };
}

export function annotationCellAt(
  state: EditorState,
  from: number,
  to: number,
  implicitColumn?: number,
) {
  const table = tableAt(state, from);
  if (!table) return null;
  const rowIndex = table.rows.findIndex((row) => row.from <= from && to <= row.to);
  const row = table.rows[rowIndex];
  if (!row) return null;
  const column =
    implicitColumn !== undefined && implicitColumn < table.columns && from === row.to
      ? implicitColumn
      : row.cells.findIndex((cell) => cell.from <= from && to <= cell.to);
  if (column < 0 || column >= table.columns) return null;
  return { table, address: { row: rowIndex, column } };
}

/** Reopen an anchor only where the source and its surrounding text still identify it. */
function locate(range: AnnotationRange, text: string): AnnotationRange | null {
  const { before, source, after, from } = range;
  const context = before + source + after;
  if (from >= before.length && text.startsWith(context, from - before.length)) return range;
  if (!context) return null;
  const begin = text.indexOf(context);
  if (begin === -1 || text.indexOf(context, begin + 1) !== -1) return null;
  const start = begin + before.length;
  return annotationRange(text, start, start + source.length);
}

function isRange(value: unknown): value is AnnotationRange {
  if (!value || typeof value !== "object") return false;
  const { from, source, before, after } = value as Record<string, unknown>;
  return (
    typeof from === "number" &&
    Number.isSafeInteger(from) &&
    from >= 0 &&
    typeof source === "string" &&
    typeof before === "string" &&
    typeof after === "string"
  );
}

function isAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== "object") return false;
  const { id, note, kind, excerpt, resolved, range, implicitColumn } = value as Record<
    string,
    unknown
  >;
  return (
    typeof id === "string" &&
    typeof note === "string" &&
    (kind === "text" || kind === "cell" || kind === "formula" || kind === "image") &&
    typeof excerpt === "string" &&
    typeof resolved === "boolean" &&
    (range === null || isRange(range)) &&
    (implicitColumn === undefined ||
      (typeof implicitColumn === "number" &&
        Number.isSafeInteger(implicitColumn) &&
        implicitColumn >= 0))
  );
}

/** One manuscript's annotations, shared by its editor panes. */
export class DocumentAnnotations {
  private items: readonly Annotation[] = [];
  private listeners = new Set<() => void>();

  getSnapshot = (): readonly Annotation[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(items: readonly Annotation[]) {
    this.items = items;
    for (const listener of this.listeners) listener();
  }

  add(target: AnnotationTarget, note: string, text: string) {
    this.set([
      ...this.items,
      {
        ...target,
        id: crypto.randomUUID(),
        note,
        resolved: false,
        range: locate(target.range, text),
      },
    ]);
  }

  setResolved(id: string, resolved: boolean) {
    this.set(this.items.map((item) => (item.id === id ? { ...item, resolved } : item)));
  }

  restore(stored: readonly unknown[], text: string) {
    const known = new Set(this.items.map((item) => item.id));
    const restored = stored
      .filter(isAnnotation)
      .filter((item) => !known.has(item.id))
      .map((item) => ({ ...item, range: item.range && locate(item.range, text) }));
    if (restored.length) this.set([...this.items, ...restored]);
  }

  record(tr: Transaction) {
    if (!this.items.some((item) => item.range)) return;
    const text = fileText(tr.state);
    let changed = false;
    const items = this.items.map((item) => {
      const range = item.range;
      if (!range) return item;
      const from = fromFileOffset(tr.startState, range.from);
      const to = fromFileOffset(tr.startState, range.from + range.source.length);
      const next = mapRange(item, tr, text, from, to);
      if (
        next &&
        range.from === next.from &&
        range.source === next.source &&
        range.before === next.before &&
        range.after === next.after
      ) {
        return item;
      }
      changed = true;
      return { ...item, range: next };
    });
    if (changed) this.set(items);
  }
}

function mapRange(item: Annotation, tr: Transaction, text: string, from: number, to: number) {
  let removed = false;
  tr.changes.iterChangedRanges((start, end, nextStart, nextEnd) => {
    if (start >= end || start > from || end < to) return;
    // Replacing the contents of one cell can leave the cell itself intact.
    removed ||= item.kind !== "cell" || start !== from || end !== to || nextStart === nextEnd;
  });
  if (removed) return item.kind === "cell" ? cellAfterFormatting(item, tr, from, to, text) : null;
  let start = tr.changes.mapPos(from, 1);
  let end = Math.max(start, tr.changes.mapPos(to, -1));
  // Large documents can be partially parsed. In that case retain the mapped range.
  if (syntaxTree(tr.state).length >= end) {
    if (item.kind === "cell") {
      const hit = annotationCellAt(tr.state, start, end, item.implicitColumn);
      if (!hit) return null;
      const cell = hit.table.rows[hit.address.row]?.cells[hit.address.column];
      start = cell?.from ?? start;
      end = cell?.to ?? end;
    } else if (item.kind !== "text") {
      const object = objectAt(tr.state, start, end);
      if (object?.kind !== item.kind) return null;
      ({ from: start, to: end } = object);
    }
  }
  return annotationRange(text, toFileOffset(tr.state, start), toFileOffset(tr.state, end));
}

/** Formatting rewrites rows in full. Keep a cell when its row contents and table shape survived. */
function cellAfterFormatting(
  item: Annotation,
  tr: Transaction,
  from: number,
  to: number,
  text: string,
) {
  const hit = annotationCellAt(tr.startState, from, to, item.implicitColumn);
  if (!hit) return null;
  const { table, address } = hit;
  const next = tableAt(tr.state, tr.changes.mapPos(table.from, -1));
  if (!next || next.columns !== table.columns || next.rows.length !== table.rows.length)
    return null;
  const before = table.rows[address.row];
  const after = next.rows[address.row];
  if (!before || !after || tr.changes.mapPos(before.lineFrom, -1) !== after.lineFrom) return null;
  for (let col = 0; col < next.columns; col++)
    if ((before.cells[col]?.text ?? "") !== (after.cells[col]?.text ?? "")) return null;
  const cell = after.cells[address.column];
  return annotationRange(
    text,
    toFileOffset(tr.state, cell?.from ?? after.to),
    toFileOffset(tr.state, cell?.to ?? after.to),
  );
}
