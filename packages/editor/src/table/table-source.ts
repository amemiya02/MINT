import { syntaxTree } from "@codemirror/language";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/**
 * A GFM table as it appears in the source, with the exact position of every
 * row, pipe and cell. Table edits are computed from this model as the
 * smallest text changes that produce the new table: editing a cell rewrites
 * only that cell's text, and the alignment spaces of every other cell stay as
 * they are (source fidelity). Only {@link formatTable} realigns whole rows.
 *
 * Rows are split exactly like Lezer's GFM table parser: an unescaped `|`
 * separates cells, a pipe with only whitespace before (after) it is the
 * leading (trailing) pipe, and a backslash escapes the next character.
 */

export type Alignment = "left" | "center" | "right" | null;

export interface TableCell {
  /** The segment between the pipes around the cell, padding included. */
  readonly from: number;
  readonly to: number;
  /** The cell's content: the segment without surrounding whitespace (empty: just after the first space). */
  readonly textFrom: number;
  readonly textTo: number;
  readonly text: string;
}

export interface TableRow {
  /** Start of the line, before any blockquote or list prefix. */
  readonly lineFrom: number;
  /** Start of the row's own text, after the container prefix. */
  readonly from: number;
  readonly to: number;
  /** The row's text, `from`–`to`. */
  readonly source: string;
  readonly cells: readonly TableCell[];
  /** Positions of the unescaped pipes. */
  readonly pipes: readonly number[];
  readonly leadingPipe: boolean;
  readonly trailingPipe: boolean;
}

export interface Table {
  readonly from: number;
  readonly to: number;
  /** Header row first, then the body rows. The delimiter row is not among them. */
  readonly rows: readonly TableRow[];
  readonly delimiter: TableRow;
  readonly alignments: readonly Alignment[];
  /** The number of columns, set by the header (and delimiter) row. */
  readonly columns: number;
}

/** A cell address: row 0 is the header row, column 0 the first column. */
export interface CellAddress {
  readonly row: number;
  readonly column: number;
}

const blank = (s: string) => /^[ \t]*$/.test(s);

function parseRow(state: EditorState, from: number, to: number): TableRow {
  const text = state.doc.sliceString(from, to);
  const pipes: number[] = [];
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "|" && !escaped) pipes.push(i);
    escaped = !escaped && text[i] === "\\";
  }
  const first = pipes[0];
  const last = pipes[pipes.length - 1];
  const leadingPipe = first !== undefined && blank(text.slice(0, first));
  const trailingPipe =
    last !== undefined && blank(text.slice(last + 1)) && !(leadingPipe && pipes.length === 1);

  const bounds: [number, number][] = [];
  if (!leadingPipe) bounds.push([0, first ?? text.length]);
  for (let i = 0; i + 1 < pipes.length; i++)
    bounds.push([(pipes[i] as number) + 1, pipes[i + 1] as number]);
  if (last !== undefined && !trailingPipe) bounds.push([last + 1, text.length]);

  const cells = bounds.map(([start, end]): TableCell => {
    const segment = text.slice(start, end);
    const content = segment.trim();
    const lead = content
      ? segment.length - segment.trimStart().length
      : Math.min(1, segment.length);
    const textFrom = from + start + lead;
    return {
      from: from + start,
      to: from + end,
      textFrom,
      textTo: textFrom + content.length,
      text: content,
    };
  });
  return {
    lineFrom: state.doc.lineAt(from).from,
    from,
    to,
    source: text,
    cells,
    pipes: pipes.map((p) => from + p),
    leadingPipe,
    trailingPipe,
  };
}

function alignmentOf(cell: TableCell | undefined): Alignment {
  const text = cell?.text ?? "";
  const left = text.startsWith(":");
  const right = text.length > 1 && text.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

/** The table described by a Lezer `Table` node. */
export function tableFromNode(state: EditorState, node: SyntaxNode): Table | null {
  const rows: TableRow[] = [];
  let delimiter: TableRow | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader" || child.name === "TableRow") {
      rows.push(parseRow(state, child.from, child.to));
    } else if (child.name === "TableDelimiter" && !delimiter) {
      delimiter = parseRow(state, child.from, child.to);
    }
  }
  const header = rows[0];
  if (!header || !delimiter) return null;
  return {
    from: node.from,
    to: node.to,
    rows,
    delimiter,
    alignments: delimiter.cells.map(alignmentOf),
    columns: header.cells.length,
  };
}

/** The table whose source contains `pos`, if any. */
export function tableAt(state: EditorState, pos: number): Table | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent)
      if (node.name === "Table") return tableFromNode(state, node);
  }
  return null;
}

/** The cell at `pos`: on the delimiter row, the header cell above it. */
export function cellAt(table: Table, pos: number): CellAddress | null {
  const inDelimiter = pos >= table.delimiter.lineFrom && pos <= table.delimiter.to;
  const index = inDelimiter
    ? 0
    : table.rows.findIndex((row) => pos >= row.lineFrom && pos <= row.to);
  const row = inDelimiter ? table.delimiter : table.rows[index];
  if (!row) return null;
  let column = row.cells.findIndex((cell) => pos <= cell.to);
  if (column < 0) column = row.cells.length - 1;
  return { row: index, column: Math.max(0, Math.min(column, table.columns - 1)) };
}

// ---------------------------------------------------------------------------
// Edits: each returns the changes, in document positions, or null when the
// edit does not apply to the table.

/** Cell content can't hold line breaks, and a bare `|` would split the cell. */
export function sanitizeCellText(text: string): string {
  let out = "";
  let escaped = false;
  for (const ch of text.replace(/\r\n?|\n/g, " ")) {
    if (ch === "|" && !escaped) out += "\\";
    out += ch;
    escaped = !escaped && ch === "\\";
  }
  return out.trim();
}

const highSurrogate = /[\uD800-\uDBFF]/;

/** Text that would start another block (list item, heading, quote, fence…) at the start of a line. */
const blockStart = /^(?:[-*+>#=~`_<]|\d+[.)])/;

/** Replace a cell's content, changing only the part that differs. */
export function setCellText(
  table: Table,
  address: CellAddress,
  value: string,
): ChangeSpec[] | null {
  const row = table.rows[address.row];
  if (!row || address.column < 0 || address.column >= table.columns) return null;
  const text = sanitizeCellText(value);
  const cell = row.cells[address.column];
  if (!cell) return text ? appendCells(row, address.column, text) : [];
  if (cell.text === text) return [];
  const changes = cellChanges(cell, text);
  // Without its leading pipe, a row whose first cell is emptied, or starts
  // like another block, would stop being a table row; an emptied last cell
  // without trailing pipe would read as one. Add the pipe in those cases.
  if (cell.from === row.from && !row.leadingPipe && (!text || blockStart.test(text)))
    changes.unshift({ from: row.from, insert: "|" });
  if (cell.to === row.to && !row.trailingPipe && !text) changes.push({ from: row.to, insert: "|" });
  return changes;
}

function cellChanges(cell: TableCell, text: string): ChangeSpec[] {
  const old = cell.text;
  if (!old) {
    // An empty cell: write over its padding, keeping one space on each side,
    // so that an aligned table stays aligned as far as the text fits.
    const width = cell.to - cell.from;
    if (width === 0) return [{ from: cell.from, insert: ` ${text} ` }];
    if (width === 1) return [{ from: cell.textFrom, insert: `${text} ` }];
    const to = Math.min(cell.textFrom + displayWidth(text), cell.to - 1);
    return [{ from: cell.textFrom, to, insert: text }];
  }
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) start++;
  if (start > 0 && highSurrogate.test(old[start - 1] ?? "")) start--;
  let end = 0;
  while (
    end < old.length - start &&
    end < text.length - start &&
    old[old.length - 1 - end] === text[text.length - 1 - end]
  )
    end++;
  if (end > 0 && highSurrogate.test(old[old.length - end - 1] ?? "")) end--;
  const from = cell.textFrom + start;
  const to = cell.textTo - end;
  return [{ from, to, insert: text.slice(start, text.length - end) }];
}

/** A row shorter than the header gets the missing cells up to `column`, which holds `text`. */
function appendCells(row: TableRow, column: number, text: string): ChangeSpec[] {
  const cells = [...Array<string>(column - row.cells.length).fill("  |"), ` ${text} |`].join("");
  const lastPipe = row.pipes[row.pipes.length - 1];
  if (row.trailingPipe && lastPipe !== undefined) return [{ from: lastPipe + 1, insert: cells }];
  return [{ from: row.to, insert: row.cells.length ? ` |${cells}` : `|${cells}` }];
}

/** All rows, the delimiter row second, in document order. */
function allRows(table: Table): TableRow[] {
  const [header, ...body] = table.rows;
  return header ? [header, table.delimiter, ...body] : [table.delimiter];
}

/** Insert an empty column so that it becomes column `index` (0 … columns). */
export function insertColumn(table: Table, index: number): ChangeSpec[] | null {
  if (index < 0 || index > table.columns) return null;
  const changes: ChangeSpec[] = [];
  for (const row of allRows(table)) {
    const segment = row === table.delimiter ? " --- " : "     ";
    const n = row.cells.length;
    if (index < n) {
      const cell = row.cells[index] as TableCell;
      if (index === 0 && !row.leadingPipe)
        changes.push({ from: row.from, insert: `|${segment}| ` });
      else changes.push({ from: cell.from, insert: `${segment}|` });
    } else if (index === n) {
      const lastPipe = row.pipes[row.pipes.length - 1];
      if (row.trailingPipe && lastPipe !== undefined)
        changes.push({ from: lastPipe + 1, insert: `${segment}|` });
      else changes.push({ from: row.to, insert: n ? ` |${segment}|` : `|${segment}|` });
    }
    // A row with fewer cells than `index` already reads as empty there.
  }
  return changes;
}

/** Delete column `index`, with one of the pipes next to it. The last column can't be deleted. */
export function deleteColumn(table: Table, index: number): ChangeSpec[] | null {
  if (table.columns <= 1 || index < 0 || index >= table.columns) return null;
  const changes: ChangeSpec[] = [];
  for (const row of allRows(table)) {
    const cell = row.cells[index];
    if (!cell) continue;
    const first = cell.from === row.from && !row.leadingPipe;
    const last = cell.to === row.to && !row.trailingPipe;
    if (first || last) {
      // At an edge without an outer pipe, the pipe next to the cell becomes
      // the outer pipe; removing it would merge a blank neighbour into it.
      changes.push({ from: cell.from, to: cell.to });
    } else {
      // Between two pipes: remove the cell with the pipe before it.
      changes.push({ from: cell.from - 1, to: cell.to });
    }
    // A row left with one cell needs a pipe after it (or it isn't a delimiter row).
    if (row.cells.length === 2 && !row.trailingPipe && !last)
      changes.push({ from: row.to, insert: "|" });
  }
  return changes;
}

/** The text of a new empty row, as wide as the delimiter row's cells. */
function emptyRow(table: Table): string {
  const segments: string[] = [];
  for (let i = 0; i < table.columns; i++) {
    const cell = table.delimiter.cells[i];
    segments.push(" ".repeat(Math.max(2, cell ? cell.to - cell.from : 5)));
  }
  return `|${segments.join("|")}|`;
}

/** The container prefix (blockquote markers, list indentation) of the table's continuation lines. */
function prefix(state: EditorState, table: Table): string {
  return state.doc.sliceString(table.delimiter.lineFrom, table.delimiter.from);
}

/** Insert an empty body row so that it becomes row `index` (1 … rows). */
export function insertRow(state: EditorState, table: Table, index: number): ChangeSpec[] | null {
  if (index < 1 || index > table.rows.length) return null;
  const line = prefix(state, table) + emptyRow(table);
  const before = index === 1 ? table.delimiter : (table.rows[index - 1] as TableRow);
  return [{ from: before.to, insert: `\n${line}` }];
}

/** Delete body row `index` and its line. The header row can't be deleted. */
export function deleteRow(state: EditorState, table: Table, index: number): ChangeSpec[] | null {
  const row = table.rows[index];
  if (index < 1 || !row) return null;
  const end = state.doc.lineAt(row.to).to;
  if (end < state.doc.length) return [{ from: row.lineFrom, to: end + 1 }];
  return [{ from: row.lineFrom - 1, to: end }];
}

/** Set a column's alignment by rewriting only its delimiter cell, keeping its width. */
export function setAlignment(
  table: Table,
  column: number,
  alignment: Alignment,
): ChangeSpec[] | null {
  const cell = table.delimiter.cells[column];
  if (!cell) return null;
  const left = alignment === "left" || alignment === "center";
  const right = alignment === "right" || alignment === "center";
  const colons = (left ? 1 : 0) + (right ? 1 : 0);
  const dashes = "-".repeat(Math.max(1, cell.text.length - colons));
  const text = `${left ? ":" : ""}${dashes}${right ? ":" : ""}`;
  if (text === cell.text) return [];
  return [{ from: cell.textFrom, to: cell.textTo, insert: text }];
}

/** Columns a string takes in a monospace font: East Asian wide and fullwidth characters take two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
        ? 2
        : 1;
  }
  return width;
}

function pad(text: string, width: number, alignment: Alignment): string {
  const space = width - displayWidth(text);
  if (alignment === "right") return " ".repeat(space) + text;
  if (alignment === "center") {
    const left = Math.floor(space / 2);
    return " ".repeat(left) + text + " ".repeat(space - left);
  }
  return text + " ".repeat(space);
}

/**
 * Realign the whole table: every row gets leading and trailing pipes and
 * every column the width of its widest cell. Rows that are already formatted
 * are left untouched.
 */
export function formatTable(table: Table): ChangeSpec[] {
  const widths: number[] = [];
  for (const row of table.rows)
    row.cells.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? (i < table.columns ? 3 : 1), displayWidth(cell.text));
    });
  const alignment = (i: number) => table.alignments[i] ?? null;
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;

  const changes: ChangeSpec[] = [];
  const replace = (row: TableRow, text: string) => {
    if (text !== row.source) changes.push({ from: row.from, to: row.to, insert: text });
  };
  for (const row of allRows(table)) {
    if (row === table.delimiter) {
      const cells = Array.from({ length: table.columns }, (_, i) => {
        const w = widths[i] ?? 3;
        const a = alignment(i);
        const left = a === "left" || a === "center";
        const right = a === "right" || a === "center";
        return `${left ? ":" : ""}${"-".repeat(w - (left ? 1 : 0) - (right ? 1 : 0))}${right ? ":" : ""}`;
      });
      replace(row, line(cells));
    } else {
      const count = Math.max(table.columns, row.cells.length);
      const cells = Array.from({ length: count }, (_, i) =>
        pad(row.cells[i]?.text ?? "", widths[i] ?? 0, alignment(i)),
      );
      replace(row, line(cells));
    }
  }
  return changes;
}

/** The source of a new table with empty cells: a header row and `rows` body rows. */
export function newTable(columns: number, rows: number): string {
  const cells = (text: string) => `|${Array<string>(columns).fill(text).join("|")}|`;
  return [cells("     "), cells(" --- "), ...Array<string>(rows).fill(cells("     "))].join("\n");
}
