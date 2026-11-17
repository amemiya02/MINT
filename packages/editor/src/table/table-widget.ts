import { redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { PreviewRenderer } from "../live-preview/preview.ts";
import { type TableAction, tableEdit } from "./commands.ts";
import {
  type CellAddress,
  insertRow,
  sanitizeCellText,
  setCellText,
  type Table,
  tableFromNode,
} from "./table-source.ts";

/**
 * The table block widget: a GFM table shown as a grid of editable cells.
 * Every operation on the grid is turned into the smallest text change in the
 * source (see table-source.ts), dispatched like any other edit, so undo,
 * autosave and source fidelity work unchanged. The widget never holds state
 * of its own beyond which cell has focus: it re-reads the table from the
 * document for every operation and is redrawn from the document after it.
 */

/** UI copy of the widget, translatable with `EditorState.phrases`. */
export const tablePhrases = [
  "Insert row above",
  "Insert row below",
  "Delete row",
  "Insert column left",
  "Insert column right",
  "Delete column",
  "Align left",
  "Align center",
  "Align right",
  "Format table",
  "Edit table source",
] as const;

type ToolbarAction = TableAction | { readonly kind: "editSource" };

const toolbar: readonly {
  name: string;
  action: ToolbarAction;
  phrase: (typeof tablePhrases)[number];
  glyph: string;
}[] = [
  {
    name: "addRowAbove",
    action: { kind: "insertRow", where: "above" },
    phrase: "Insert row above",
    glyph: "+↑",
  },
  {
    name: "addRowBelow",
    action: { kind: "insertRow", where: "below" },
    phrase: "Insert row below",
    glyph: "+↓",
  },
  { name: "deleteRow", action: { kind: "deleteRow" }, phrase: "Delete row", glyph: "−row" },
  {
    name: "addColumnLeft",
    action: { kind: "insertColumn", where: "left" },
    phrase: "Insert column left",
    glyph: "+←",
  },
  {
    name: "addColumnRight",
    action: { kind: "insertColumn", where: "right" },
    phrase: "Insert column right",
    glyph: "+→",
  },
  {
    name: "deleteColumn",
    action: { kind: "deleteColumn" },
    phrase: "Delete column",
    glyph: "−col",
  },
  {
    name: "alignLeft",
    action: { kind: "align", alignment: "left" },
    phrase: "Align left",
    glyph: "⇤",
  },
  {
    name: "alignCenter",
    action: { kind: "align", alignment: "center" },
    phrase: "Align center",
    glyph: "↔",
  },
  {
    name: "alignRight",
    action: { kind: "align", alignment: "right" },
    phrase: "Align right",
    glyph: "⇥",
  },
  { name: "format", action: { kind: "format" }, phrase: "Format table", glyph: "⊞" },
  { name: "editSource", action: { kind: "editSource" }, phrase: "Edit table source", glyph: "</>" },
];

/** The table rendered by the widget whose DOM starts at `lineFrom`. */
function tableOnLine(state: EditorState, lineFrom: number): Table | null {
  let table: Table | null = null;
  const to = state.doc.lineAt(lineFrom).to;
  syntaxTree(state).iterate({
    from: lineFrom,
    to,
    enter(node) {
      if (table) return false;
      if (node.name !== "Table") return undefined;
      table = tableFromNode(state, node.node);
      return false;
    },
  });
  return table;
}

const controllers = new WeakMap<HTMLElement, TableController>();

/** Focus a cell of the table widget at `lineFrom`, with the caret at `caret` (default: end). */
export function focusTableCell(
  view: EditorView,
  lineFrom: number,
  address: CellAddress,
  caret?: "start" | "end",
): boolean {
  for (const dom of view.contentDOM.querySelectorAll<HTMLElement>(".cm-mint-table")) {
    const controller = controllers.get(dom);
    if (controller && view.posAtDOM(dom) === lineFrom) return controller.focus(address, caret);
  }
  return false;
}

/** Run `action` on the table widget that has focus in `view`; undefined when none has. */
export function runInFocusedTable(view: EditorView, action: TableAction): boolean | undefined {
  const active = view.dom.ownerDocument.activeElement;
  const dom = active?.closest<HTMLElement>(".cm-mint-table");
  const controller = dom && view.contentDOM.contains(dom) ? controllers.get(dom) : undefined;
  return controller?.run(action);
}

/** Renders Markdown to HTML the way the export does (dialect included). */
export type MarkdownToHtml = (markdown: string) => string;

/**
 * Each cell's content rendered by the export pipeline, so that a table looks
 * the same in the editor and in the export; null where it can't be matched up.
 */
function renderCells(table: Table, toHtml: MarkdownToHtml): (string | null)[][] {
  const source = [table.rows[0], table.delimiter, ...table.rows.slice(1)]
    .map((row) => row?.source ?? "")
    .join("\n");
  const template = document.createElement("template");
  template.innerHTML = toHtml(source);
  const rows = [...template.content.querySelectorAll("table > thead > tr, table > tbody > tr")];
  return table.rows.map((_, r) => {
    const cells = rows.length === table.rows.length ? rows[r]?.children : undefined;
    return Array.from({ length: table.columns }, (_, c) => cells?.[c]?.innerHTML ?? null);
  });
}

class TableController {
  readonly dom: HTMLElement;
  private readonly grid: HTMLTableElement;
  private table: Table;
  private html: (string | null)[][];
  /** What each cell element shows now, so unchanged cells are not redrawn. */
  private readonly showing = new WeakMap<HTMLElement, string>();
  /** The cell the toolbar acts on: the focused one, or the last one that had focus. */
  private active: CellAddress = { row: 0, column: 0 };
  private composing = false;

  constructor(
    private readonly view: EditorView,
    table: Table,
    private readonly toHtml: MarkdownToHtml,
  ) {
    this.table = table;
    this.html = renderCells(table, toHtml);
    this.dom = document.createElement("div");
    this.dom.className = "cm-mint-table";
    this.dom.contentEditable = "false";
    this.dom.append(this.buildToolbar());
    this.grid = document.createElement("table");
    this.dom.append(this.grid);
    this.render();
    controllers.set(this.dom, this);

    // A cell shows its rendered content, and its Markdown source while it has focus.
    this.dom.addEventListener("focusin", (event) => {
      const address = this.addressOf(event.target);
      if (!address) return;
      this.active = address;
      const element = this.cellElement(address);
      if (element && this.showSource(element, address)) this.placeCaret(element, "end");
    });
    this.dom.addEventListener("focusout", (event) => {
      const address = this.addressOf(event.target);
      const element = address && this.cellElement(address);
      if (address && element) this.showRendered(element, address);
    });
    this.dom.addEventListener("input", (event) => {
      if (this.composing || (event as InputEvent).isComposing) return;
      this.commit(event.target);
    });
    this.dom.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.dom.addEventListener("compositionend", (event) => {
      this.composing = false;
      this.commit(event.target);
    });
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
  }

  // -- rendering ------------------------------------------------------------

  private buildToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-mint-table-toolbar";
    for (const { name, action, phrase, glyph } of toolbar) {
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.dataset.mintAction = name;
      button.textContent = glyph;
      button.title = this.view.state.phrase(phrase);
      button.setAttribute("aria-label", button.title);
      // Keep focus (and the active cell) in the grid.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.run(action));
      bar.append(button);
    }
    return bar;
  }

  private render() {
    const { table } = this;
    const focused = this.focusedAddress();
    const caret = focused ? this.caretOffset() : null;
    this.grid.replaceChildren();
    const head = this.grid.createTHead();
    const body = this.grid.createTBody();
    table.rows.forEach((_, r) => {
      const tr = (r === 0 ? head : body).insertRow();
      for (let c = 0; c < table.columns; c++) {
        const td = document.createElement(r === 0 ? "th" : "td");
        const align = table.alignments[c];
        if (align) td.style.textAlign = align;
        const cell = document.createElement("div");
        cell.className = "cm-mint-table-cell";
        cell.dataset.mintCell = `${r}:${c}`;
        cell.setAttribute("contenteditable", "plaintext-only");
        cell.spellcheck = true;
        this.showRendered(cell, { row: r, column: c });
        td.append(cell);
        tr.append(td);
      }
    });
    if (focused) this.focus(clamp(focused, table), caret ?? "end");
  }

  /** Bring the grid up to date with a new version of the table's source. */
  update(table: Table) {
    const old = this.table;
    this.table = table;
    this.html = renderCells(table, this.toHtml);
    const sameShape =
      old.rows.length === table.rows.length &&
      old.columns === table.columns &&
      old.alignments.join() === table.alignments.join();
    if (!sameShape) return this.render();
    const focused = this.focusedAddress();
    for (const element of this.grid.querySelectorAll<HTMLElement>("[data-mint-cell]")) {
      const address = this.addressOf(element);
      if (!address) continue;
      if (focused?.row !== address.row || focused.column !== address.column) {
        this.showRendered(element, address);
        continue;
      }
      // The focused cell may hold what the user is typing (say, a trailing
      // space) that the source holds normalized; leave it alone then.
      const text = this.sourceOf(address);
      if (sanitizeCellText(element.textContent ?? "") !== text) {
        this.showSource(element, address, true);
        this.placeCaret(element, "end");
      }
    }
  }

  private sourceOf({ row, column }: CellAddress): string {
    return this.table.rows[row]?.cells[column]?.text ?? "";
  }

  /** Show the cell's Markdown source; returns whether the content changed. */
  private showSource(element: HTMLElement, address: CellAddress, force = false): boolean {
    const text = this.sourceOf(address);
    const key = `source:${text}`;
    if (!force && this.showing.get(element) === key) return false;
    element.textContent = text;
    this.showing.set(element, key);
    return true;
  }

  private showRendered(element: HTMLElement, address: CellAddress) {
    const html = this.html[address.row]?.[address.column] ?? null;
    const key = html === null ? `text:${this.sourceOf(address)}` : `html:${html}`;
    if (this.showing.get(element) === key) return;
    if (html === null) element.textContent = this.sourceOf(address);
    else element.innerHTML = html;
    this.showing.set(element, key);
  }

  // -- focus and caret --------------------------------------------------------

  private cellElement({ row, column }: CellAddress): HTMLElement | null {
    return this.grid.querySelector<HTMLElement>(`[data-mint-cell="${row}:${column}"]`);
  }

  private addressOf(target: EventTarget | null): CellAddress | null {
    const element =
      target instanceof Element ? target.closest<HTMLElement>("[data-mint-cell]") : null;
    const [row, column] = (element?.dataset.mintCell ?? "").split(":").map(Number);
    if (row === undefined || column === undefined || Number.isNaN(row) || Number.isNaN(column))
      return null;
    return { row, column };
  }

  private focusedAddress(): CellAddress | null {
    const active = this.dom.ownerDocument.activeElement;
    return active && this.grid.contains(active) ? this.addressOf(active) : null;
  }

  focus(address: CellAddress, caret: "start" | "end" | number = "end"): boolean {
    const element = this.cellElement(address);
    if (!element) return false;
    this.active = address;
    element.focus();
    this.placeCaret(element, caret);
    return true;
  }

  private placeCaret(element: HTMLElement, caret: "start" | "end" | number) {
    const length = element.textContent?.length ?? 0;
    const offset = caret === "start" ? 0 : caret === "end" ? length : Math.min(caret, length);
    const selection = element.ownerDocument.getSelection();
    const text = element.firstChild;
    if (selection) {
      const range = element.ownerDocument.createRange();
      if (text) range.setStart(text, offset);
      else range.setStart(element, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  /** The caret's offset in the focused cell's text, or null without a collapsed caret. */
  private caretOffset(): number | null {
    const selection = this.dom.ownerDocument.getSelection();
    const focused = this.focusedAddress();
    const element = focused && this.cellElement(focused);
    if (!selection || !element || selection.rangeCount === 0 || !selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) return null;
    const before = element.ownerDocument.createRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().length;
  }

  // -- edits ----------------------------------------------------------------

  /** The table as it is in the document now, and where its widget starts. */
  private current(): { table: Table; lineFrom: number } | null {
    const lineFrom = this.view.posAtDOM(this.dom);
    const table = tableOnLine(this.view.state, lineFrom);
    return table ? { table, lineFrom } : null;
  }

  private dispatch(changes: ChangeSpec[] | null, userEvent: string): boolean {
    if (!changes) return false;
    if (changes.length) this.view.dispatch({ changes, userEvent });
    return true;
  }

  private commit(target: EventTarget | null) {
    const address = this.addressOf(target);
    const current = this.current();
    if (!address || !current || !(target instanceof HTMLElement)) return;
    const cell = target.closest<HTMLElement>("[data-mint-cell]");
    this.dispatch(setCellText(current.table, address, cell?.textContent ?? ""), "input.type");
  }

  /** Move the focus to another cell after an edit; the widget may have been redrawn. */
  private refocus(lineFrom: number, address: CellAddress, caret: "start" | "end" = "end") {
    const table = tableOnLine(this.view.state, lineFrom);
    if (!table) return;
    focusTableCell(this.view, lineFrom, clamp(address, table), caret);
  }

  run(action: ToolbarAction): boolean {
    const current = this.current();
    if (!current) return false;
    const { table, lineFrom } = current;
    const address = clamp(this.active, table);
    if (action.kind === "editSource") {
      const cell = table.rows[address.row]?.cells[address.column];
      const anchor = cell ? cell.textTo : (table.rows[address.row]?.to ?? table.from);
      this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
      this.view.focus();
      return true;
    }
    const edit = tableEdit(this.view.state, table, address, action);
    if (!edit) return false;
    if (edit.changes.length)
      this.view.dispatch({ changes: edit.changes, userEvent: edit.userEvent });
    this.refocus(lineFrom, edit.next);
    return true;
  }

  /** Leave the grid for the text before or after the table. */
  private leave(side: "before" | "after") {
    const current = this.current();
    if (!current) return;
    const doc = this.view.state.doc;
    const anchor =
      side === "before"
        ? Math.max(0, current.lineFrom - 1)
        : Math.min(doc.length, current.table.to + 1);
    this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
    this.view.focus();
  }

  private keydown(event: KeyboardEvent) {
    if (event.isComposing || this.composing || event.keyCode === 229) return;
    const address = this.addressOf(event.target);
    if (!address) return;
    const { row, column } = address;
    const { table } = this;
    const lastRow = table.rows.length - 1;
    const lastColumn = table.columns - 1;
    const mod = event.metaKey || event.ctrlKey;
    const go = (to: CellAddress, caret: "start" | "end" = "end") => {
      event.preventDefault();
      this.focus(to, caret);
    };
    const offset = this.caretOffset();
    const length = (event.target as HTMLElement).textContent?.length ?? 0;

    if (mod && !event.altKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      (event.shiftKey ? redo : undo)(this.view);
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
      // The cell sits inside the editor's own editable content: the browser's
      // select-all would select the whole document, and typing would replace it.
      event.preventDefault();
      const cell = event.target as HTMLElement;
      const range = cell.ownerDocument.createRange();
      range.selectNodeContents(cell);
      const selection = cell.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    if (mod && !event.altKey && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo(this.view);
      return;
    }
    if (mod || event.altKey) return;

    switch (event.key) {
      case "Tab":
        if (event.shiftKey) {
          if (column > 0) go({ row, column: column - 1 });
          else if (row > 0) go({ row: row - 1, column: lastColumn });
          else event.preventDefault();
        } else if (column < lastColumn) go({ row, column: column + 1 });
        else if (row < lastRow) go({ row: row + 1, column: 0 });
        else {
          // Tab in the last cell adds a row.
          event.preventDefault();
          this.active = address;
          const current = this.current();
          if (!current) return;
          this.dispatch(
            insertRow(this.view.state, current.table, current.table.rows.length),
            "input",
          );
          this.refocus(current.lineFrom, { row: row + 1, column: 0 });
        }
        return;
      case "ArrowUp":
        if (event.shiftKey) return;
        if (row > 0) go({ row: row - 1, column });
        else {
          event.preventDefault();
          this.leave("before");
        }
        return;
      case "ArrowDown":
      case "Enter":
        if (event.shiftKey) return;
        if (row < lastRow) go({ row: row + 1, column });
        else {
          event.preventDefault();
          this.leave("after");
        }
        return;
      case "ArrowLeft":
        if (event.shiftKey || offset !== 0) return;
        if (column > 0) go({ row, column: column - 1 });
        else if (row > 0) go({ row: row - 1, column: lastColumn });
        else {
          event.preventDefault();
          this.leave("before");
        }
        return;
      case "ArrowRight":
        if (event.shiftKey || offset !== length) return;
        if (column < lastColumn) go({ row, column: column + 1 }, "start");
        else if (row < lastRow) go({ row: row + 1, column: 0 }, "start");
        else {
          event.preventDefault();
          this.leave("after");
        }
        return;
      case "Escape":
        event.preventDefault();
        this.leave("after");
        return;
    }
  }
}

function clamp(address: CellAddress, table: Table): CellAddress {
  return {
    row: Math.max(0, Math.min(address.row, table.rows.length - 1)),
    column: Math.max(0, Math.min(address.column, table.columns - 1)),
  };
}

class TableWidget extends WidgetType {
  constructor(
    readonly table: Table,
    readonly source: string,
    readonly toHtml: MarkdownToHtml,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  toDOM(view: EditorView): HTMLElement {
    return new TableController(view, this.table, this.toHtml).dom;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const controller = controllers.get(dom);
    if (!controller) return false;
    controller.update(this.table);
    return true;
  }

  override get estimatedHeight(): number {
    return 32 + this.table.rows.length * 30;
  }

  /** Events inside the grid belong to the widget, not to the editor. */
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Renders GFM tables as {@link TableWidget}s. Like other block widgets, the
 * table expands to its source while the selection is on one of its lines.
 */
export function tableRenderer(render: MarkdownToHtml): PreviewRenderer {
  // Tables are redrawn on every edit; most of them did not change.
  const cache = new Map<string, string>();
  const toHtml = (markdown: string) => {
    let html = cache.get(markdown);
    if (html === undefined) {
      html = render(markdown);
      if (cache.size >= 64) cache.delete(cache.keys().next().value as string);
      cache.set(markdown, html);
    }
    return html;
  };
  return {
    nodes: ["Table"],
    scope: "block",
    render(node, cx) {
      const table = tableFromNode(cx.state, node);
      if (!table) return false;
      const from = cx.state.doc.lineAt(node.from).from;
      // Revealed: the source shows, with whatever renders inside it (e.g. math).
      if (cx.touchesSelectedLines(from, node.to)) return true;
      const source = cx.state.doc.sliceString(from, node.to);
      const widget = new TableWidget(table, source, toHtml);
      cx.add(from, node.to, Decoration.replace({ widget, block: true }));
      return false;
    },
  };
}

export const tableTheme = EditorView.baseTheme({
  ".cm-mint-table": {
    position: "relative",
    margin: "0.5em 0",
    overflowX: "auto",
  },
  ".cm-mint-table table": {
    borderCollapse: "collapse",
  },
  ".cm-mint-table th, .cm-mint-table td": {
    border: "1px solid var(--mint-border, rgba(127, 127, 127, 0.35))",
    padding: "0",
    minWidth: "3em",
    verticalAlign: "top",
  },
  ".cm-mint-table th": {
    fontWeight: "bold",
    backgroundColor: "var(--mint-hover, rgba(127, 127, 127, 0.08))",
  },
  ".cm-mint-table-cell": {
    padding: "0.25em 0.6em",
    outline: "none",
    minHeight: "1.4em",
    whiteSpace: "pre-wrap",
  },
  ".cm-mint-table-cell:focus": {
    boxShadow: "inset 0 0 0 2px var(--mint-accent, #2f7d6d)",
  },
  ".cm-mint-table-toolbar": {
    display: "flex",
    gap: "2px",
    visibility: "hidden",
    fontSize: "0.8em",
    marginBottom: "2px",
  },
  ".cm-mint-table:focus-within .cm-mint-table-toolbar, .cm-mint-table:hover .cm-mint-table-toolbar":
    { visibility: "visible" },
  ".cm-mint-table-toolbar button": {
    font: "inherit",
    border: "1px solid var(--mint-border, rgba(127, 127, 127, 0.35))",
    borderRadius: "3px",
    background: "transparent",
    color: "inherit",
    padding: "0 0.4em",
    cursor: "pointer",
  },
});
