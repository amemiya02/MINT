import type { ChangeSpec, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  type CellAddress,
  cellAt,
  deleteColumn,
  deleteRow,
  formatTable,
  insertColumn,
  insertRow,
  newTable,
  setAlignment,
  type Table,
  tableAt,
} from "./table-source.ts";

export type TableAlignment = "left" | "center" | "right" | "none";

/** Editor commands for tables. They act on the focused cell of a table widget, or else on the cell at the cursor. */
export interface TableCommands {
  /** Insert a table with empty cells (default: 3 columns, a header and 2 rows) after the cursor's line. */
  insertTable: [columns?: number, rows?: number];
  /** Realign the whole table: the only table command that rewrites every row. */
  formatTable: [];
  insertTableRow: [where: "above" | "below"];
  deleteTableRow: [];
  insertTableColumn: [where: "left" | "right"];
  deleteTableColumn: [];
  setTableAlignment: [alignment: TableAlignment];
}

/** An edit of a table cell's row, column or the whole table. */
export type TableAction =
  | { readonly kind: "insertRow"; readonly where: "above" | "below" }
  | { readonly kind: "deleteRow" }
  | { readonly kind: "insertColumn"; readonly where: "left" | "right" }
  | { readonly kind: "deleteColumn" }
  | { readonly kind: "align"; readonly alignment: TableAlignment }
  | { readonly kind: "format" };

export interface TableEdit {
  readonly changes: ChangeSpec[];
  readonly userEvent: string;
  /** The cell that should have focus afterwards. */
  readonly next: CellAddress;
}

/** The text changes for `action` on the cell at `address`, or null when it does not apply. */
export function tableEdit(
  state: EditorState,
  table: Table,
  address: CellAddress,
  action: TableAction,
): TableEdit | null {
  const { row, column } = address;
  const edit = (changes: ChangeSpec[] | null, next: CellAddress, userEvent = "input") =>
    changes ? { changes, userEvent, next } : null;
  switch (action.kind) {
    case "insertRow": {
      const at = action.where === "above" ? Math.max(1, row) : row + 1;
      return edit(insertRow(state, table, at), { row: at, column });
    }
    case "deleteRow":
      return edit(
        deleteRow(state, table, row),
        { row: Math.min(row, table.rows.length - 2), column },
        "delete",
      );
    case "insertColumn": {
      const at = action.where === "left" ? column : column + 1;
      return edit(insertColumn(table, at), { row, column: at });
    }
    case "deleteColumn":
      return edit(
        deleteColumn(table, column),
        { row, column: Math.min(column, table.columns - 2) },
        "delete",
      );
    case "align":
      return edit(
        setAlignment(table, column, action.alignment === "none" ? null : action.alignment),
        address,
      );
    case "format":
      return edit(formatTable(table), address);
  }
}

/**
 * Runs a table action on a focused table widget, if one has focus; returns
 * undefined when none has.
 */
export type FocusedTableRunner = (view: EditorView, action: TableAction) => boolean | undefined;

export function tableCommands(
  view: EditorView,
  runInWidget: FocusedTableRunner,
  focusCell: (view: EditorView, tableFrom: number, address: CellAddress) => boolean,
): { [C in keyof TableCommands]: (...args: TableCommands[C]) => boolean } {
  const run = (action: TableAction): boolean => {
    const inWidget = runInWidget(view, action);
    if (inWidget !== undefined) return inWidget;
    const { state } = view;
    const head = state.selection.main.head;
    const table = tableAt(state, head);
    const address = table && cellAt(table, head);
    if (!table || !address) return false;
    const edit = tableEdit(state, table, address, action);
    if (!edit) return false;
    if (!edit.changes.length) return true;
    const changes = state.changes(edit.changes);
    view.dispatch({ changes, userEvent: edit.userEvent });
    // Put the cursor in the cell the edit leads to, e.g. the new row.
    const after = tableAt(view.state, changes.mapPos(table.from, -1));
    const row = after?.rows[edit.next.row];
    const cell = row?.cells[edit.next.column];
    const anchor = cell ? cell.textTo : row?.to;
    if (anchor !== undefined) view.dispatch({ selection: { anchor } });
    return true;
  };

  return {
    insertTable(columns = 3, rows = 2) {
      if (columns < 1 || rows < 0) return false;
      const { state } = view;
      const line = state.doc.lineAt(state.selection.main.head);
      const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
      const previous = line.number > 1 ? state.doc.line(line.number - 1) : null;
      const blank = (text: string | undefined) => !text || /^\s*$/.test(text);
      // The table goes on the cursor's line if it is empty, else after it. It
      // needs a blank line before it (or it would continue a paragraph) and
      // a line after it that is blank (or that line would become a row),
      // which is also where the cursor goes.
      const onLine = blank(line.text);
      const from = onLine ? line.from : line.to;
      const before = onLine ? (previous && !blank(previous.text) ? "\n" : "") : "\n\n";
      const after = next && blank(next.text) ? "" : "\n";
      const source = newTable(columns, rows);
      const tableFrom = from + before.length;
      view.dispatch({
        changes: { from, to: onLine ? line.to : from, insert: before + source + after },
        selection: { anchor: tableFrom + source.length + 1 },
        userEvent: "input",
        scrollIntoView: true,
      });
      focusCell(view, tableFrom, { row: 0, column: 0 });
      return true;
    },
    formatTable: () => run({ kind: "format" }),
    insertTableRow: (where) => run({ kind: "insertRow", where }),
    deleteTableRow: () => run({ kind: "deleteRow" }),
    insertTableColumn: (where) => run({ kind: "insertColumn", where }),
    deleteTableColumn: () => run({ kind: "deleteColumn" }),
    setTableAlignment: (alignment) => run({ kind: "align", alignment }),
  };
}
