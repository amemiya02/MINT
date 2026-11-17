// The table block widget, through the editor core's public interface: the
// rendered table (what the user sees and edits) and the text it produces.
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, type EditorOptions, type MintEditor } from "../src/index.ts";
import { finishParsing } from "./parsed.ts";

const mounted: { editor: MintEditor; parent: HTMLElement }[] = [];
function open(text: string, options: Partial<EditorOptions> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text, ...options });
  mounted.push({ editor, parent });
  finishParsing(parent);
  // Park the cursor after the table (the samples end outside it) so it renders.
  editor.setSelection({ anchor: text.length });
  const table = (index = 0) => {
    const element = parent.querySelectorAll<HTMLElement>(".cm-mint-table")[index];
    if (!element) throw new Error(`No rendered table #${index}`);
    return element;
  };
  /** The rendered cells, row by row (header first). */
  const grid = (index = 0) =>
    [...table(index).querySelectorAll("tr")].map((row) =>
      [...row.querySelectorAll<HTMLElement>("[data-mint-cell]")].map((cell) => cell.textContent),
    );
  const cell = (row: number, column: number, index = 0) => {
    const element = table(index).querySelector<HTMLElement>(`[data-mint-cell="${row}:${column}"]`);
    if (!element) throw new Error(`No cell ${row}:${column}`);
    return element;
  };
  return { editor, parent, table, grid, cell };
}
afterEach(() => {
  for (const { editor, parent } of mounted.splice(0)) {
    editor.destroy();
    parent.remove();
  }
});

const sample = "intro\n\n| Name | Qty |\n|:-----|----:|\n| 苹果 |   3 |\n| pear |  12 |\n\nend";

describe("table block widget", () => {
  it("renders a table as an editable grid while the cursor is elsewhere", () => {
    const { editor, grid, parent } = open(sample);
    editor.setSelection({ anchor: 0 });
    expect(grid()).toEqual([
      ["Name", "Qty"],
      ["苹果", "3"],
      ["pear", "12"],
    ]);
    expect(parent.textContent).not.toContain("|:-----|");
  });

  it("shows column alignment from the delimiter row", () => {
    const { editor, cell } = open(sample);
    editor.setSelection({ anchor: 0 });
    expect(cell(0, 0).closest("th")?.style.textAlign).toBe("left");
    expect(cell(1, 1).closest("td")?.style.textAlign).toBe("right");
  });

  it("expands to source when the selection enters the table's lines", () => {
    const { editor, parent } = open(sample);
    editor.setSelection({ anchor: sample.indexOf("pear") });
    expect(parent.querySelector(".cm-mint-table")).toBeNull();
    expect(parent.textContent).toContain("| pear |  12 |");
  });
});

/** Replace a cell's text the way typing does: the DOM changes, then `input` fires. */
function typeInto(cell: HTMLElement, text: string) {
  cell.focus();
  cell.textContent = text;
  cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

describe("editing cells", () => {
  it("rewrites only the edited cell; the other cells keep their alignment spaces", () => {
    const { editor, cell, grid } = open(sample);
    editor.setSelection({ anchor: 0 });
    typeInto(cell(1, 0), "香蕉");
    expect(editor.getText()).toBe(sample.replace("| 苹果 |", "| 香蕉 |"));
    typeInto(cell(2, 1), "120");
    expect(editor.getText()).toBe(
      sample.replace("| 苹果 |", "| 香蕉 |").replace("|  12 |", "|  120 |"),
    );
    expect(grid()[2]).toEqual(["pear", "120"]);
  });

  it("changes only the differing characters, so the edit is as small as possible", () => {
    const text = "| a | b |\n|---|---|\n| hello world |   x |\n";
    const { editor, cell } = open(text);
    const changes: string[] = [];
    editor.subscribe((event) => {
      if (event.type === "change") changes.push(editor.getText());
    });
    typeInto(cell(1, 0), "hello brave world");
    expect(editor.getText()).toBe("| a | b |\n|---|---|\n| hello brave world |   x |\n");
    expect(changes).toHaveLength(1);
  });

  it("fills an empty cell and a cell missing from a short row", () => {
    const text = "| a | b | c |\n|---|---|---|\n|   | x |\n";
    const { editor, cell } = open(text);
    typeInto(cell(1, 0), "1");
    expect(editor.getText()).toBe("| a | b | c |\n|---|---|---|\n| 1 | x |\n");
    typeInto(cell(1, 2), "3");
    expect(editor.getText()).toBe("| a | b | c |\n|---|---|---|\n| 1 | x | 3 |\n");
  });

  it("escapes a typed pipe and keeps line breaks out of the cell", () => {
    const text = "a | b\n--|--\nc | d\n";
    const { editor, cell, grid } = open(text);
    typeInto(cell(1, 1), "x|y");
    expect(editor.getText()).toBe("a | b\n--|--\nc | x\\|y\n");
    typeInto(cell(0, 0), "p\nq");
    expect(editor.getText()).toBe("p q | b\n--|--\nc | x\\|y\n");
    expect(grid()).toHaveLength(2);
  });

  it("keeps what the user is typing in the focused cell, such as a trailing space", () => {
    const text = "| a | b |\n|---|---|\n| c | d |\n";
    const { editor, cell } = open(text);
    typeInto(cell(1, 0), "c ");
    expect(cell(1, 0).textContent).toBe("c ");
    typeInto(cell(1, 0), "c d");
    expect(editor.getText()).toBe("| a | b |\n|---|---|\n| c d | d |\n");
  });

  it("undoes a cell edit like any other edit", () => {
    const { editor, cell } = open(sample);
    typeInto(cell(1, 0), "梨");
    expect(editor.execute("undo")).toBe(true);
    expect(editor.getText()).toBe(sample);
    expect(cell(1, 0).textContent).toBe("苹果");
  });
});

function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement;
  if (!target) throw new Error("Nothing has focus");
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}
const focusedCell = () => (document.activeElement as HTMLElement | null)?.dataset.mintCell;

describe("keyboard navigation", () => {
  const text = "above\n\n| a | b |\n|---|---|\n| c | d |\n\nbelow";

  it("moves through the cells with Tab and Shift+Tab, row by row", () => {
    const { cell } = open(text);
    cell(0, 0).focus();
    press("Tab");
    expect(focusedCell()).toBe("0:1");
    press("Tab");
    expect(focusedCell()).toBe("1:0");
    press("Tab", { shiftKey: true });
    expect(focusedCell()).toBe("0:1");
  });

  it("adds a row when Tab is pressed in the last cell, and moves into it", () => {
    const { editor, cell, grid } = open(text);
    cell(1, 1).focus();
    press("Tab");
    expect(editor.getText()).toBe("above\n\n| a | b |\n|---|---|\n| c | d |\n|   |   |\n\nbelow");
    expect(grid()).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["", ""],
    ]);
    expect(focusedCell()).toBe("2:0");
    typeInto(cell(2, 0), "e");
    expect(editor.getText()).toBe("above\n\n| a | b |\n|---|---|\n| c | d |\n| e |   |\n\nbelow");
  });

  it("moves between rows with the arrow keys and leaves the table at its edges", () => {
    const { editor, cell } = open(text);
    cell(0, 1).focus();
    press("ArrowDown");
    expect(focusedCell()).toBe("1:1");
    press("ArrowUp");
    expect(focusedCell()).toBe("0:1");
    press("ArrowUp");
    expect(editor.getSelection().anchor).toBe(text.indexOf("|") - 1);

    cell(1, 0).focus();
    press("ArrowDown");
    expect(editor.getSelection().anchor).toBe(text.indexOf("\nbelow"));
  });

  it("moves to the neighbouring cell with ←/→ at the edge of a cell's text", () => {
    const { cell } = open(text);
    const caretAt = (element: HTMLElement, offset: number) => {
      element.focus();
      document.getSelection()?.collapse(element.firstChild, offset);
    };
    caretAt(cell(0, 1), 0);
    press("ArrowLeft");
    expect(focusedCell()).toBe("0:0");
    caretAt(cell(0, 0), 0);
    press("ArrowRight"); // not at the end of "a": stays
    expect(focusedCell()).toBe("0:0");
    caretAt(cell(0, 0), 1);
    press("ArrowRight");
    expect(focusedCell()).toBe("0:1");
  });

  it("selects only the cell's text with ⌘A / Ctrl+A", () => {
    const { cell } = open(text);
    cell(1, 0).focus();
    press("a", { metaKey: true, ctrlKey: true });
    expect(document.getSelection()?.toString()).toBe("c");
  });

  it("undoes with ⌘Z / Ctrl+Z inside a cell", () => {
    const { editor, cell } = open(text);
    typeInto(cell(1, 0), "x");
    press("z", { metaKey: true, ctrlKey: true });
    expect(editor.getText()).toBe(text);
  });
});

describe("table toolbar", () => {
  const text = "| Name | Qty |\n|:-----|----:|\n| 苹果 |   3 |\n\nend";
  function withToolbar(source = text) {
    const view = open(source);
    const click = (action: string) => {
      const button = view.table().querySelector<HTMLElement>(`[data-mint-action="${action}"]`);
      if (!button) throw new Error(`No ${action} button`);
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      button.click();
    };
    return { ...view, click };
  }

  it("adds and deletes rows next to the focused cell, touching only that line", () => {
    const { editor, cell, click } = withToolbar();
    cell(1, 1).focus();
    click("addRowAbove");
    expect(editor.getText()).toBe(
      "| Name | Qty |\n|:-----|----:|\n|      |     |\n| 苹果 |   3 |\n\nend",
    );
    expect(focusedCell()).toBe("1:1");
    click("deleteRow");
    expect(editor.getText()).toBe(text);
    cell(1, 0).focus();
    click("addRowBelow");
    expect(editor.getText()).toBe(
      "| Name | Qty |\n|:-----|----:|\n| 苹果 |   3 |\n|      |     |\n\nend",
    );
    expect(focusedCell()).toBe("2:0");
  });

  it("adds and deletes columns, inserting one cell per row", () => {
    const { editor, cell, click, grid } = withToolbar();
    cell(0, 0).focus();
    click("addColumnRight");
    expect(editor.getText()).toBe(
      "| Name |     | Qty |\n|:-----| --- |----:|\n| 苹果 |     |   3 |\n\nend",
    );
    expect(focusedCell()).toBe("0:1");
    typeInto(cell(0, 1), "Unit");
    expect(grid()[0]).toEqual(["Name", "Unit", "Qty"]);
    click("deleteColumn");
    expect(editor.getText()).toBe(text);
    click("addColumnLeft");
    expect(grid()[0]).toEqual(["Name", "", "Qty"]);
  });

  it("sets a column's alignment by rewriting only its delimiter cell", () => {
    const { editor, cell, click } = withToolbar();
    cell(1, 1).focus();
    click("alignCenter");
    expect(editor.getText()).toBe(text.replace("----:", ":---:"));
    click("alignLeft");
    expect(editor.getText()).toBe(text.replace("----:", ":----"));
    expect(cell(1, 1).closest("td")?.style.textAlign).toBe("left");
  });

  it("labels its buttons in the host's language", () => {
    const { table } = open("| a |\n|---|\n", { phrases: { "Format table": "格式化表格" } });
    const format = table().querySelector<HTMLElement>('[data-mint-action="format"]');
    expect(format?.getAttribute("aria-label")).toBe("格式化表格");
    const left = table().querySelector<HTMLElement>('[data-mint-action="alignLeft"]');
    expect(left?.getAttribute("aria-label")).toBe("Align left");
  });

  it("does not delete the header row or the last column", () => {
    const { editor, cell, click } = withToolbar("| a |\n|---|\n| b |\n");
    cell(0, 0).focus();
    click("deleteRow");
    click("deleteColumn");
    expect(editor.getText()).toBe("| a |\n|---|\n| b |\n");
  });

  it("expands the table to its source, with the cursor in the cell that had focus", () => {
    const { editor, cell, click, parent } = withToolbar();
    cell(1, 0).focus();
    click("editSource");
    expect(parent.querySelector(".cm-mint-table")).toBeNull();
    expect(editor.getSelection().anchor).toBe(text.indexOf("苹果") + 2);
  });
});

describe("IME in cells", () => {
  it("writes the composed text once the composition ends, not the intermediate pinyin", () => {
    const text = "| 名 | 值 |\n|---|---|\n|   | 1 |\n";
    const { editor, cell } = open(text);
    const changes: string[] = [];
    editor.subscribe((event) => {
      if (event.type === "change") changes.push(editor.getText());
    });
    const target = cell(1, 0);
    target.focus();
    target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    for (const step of ["z", "zh", "zhong", "中"]) {
      target.textContent = step;
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, isComposing: true, data: step }),
      );
      press("Process", { isComposing: true, keyCode: 229 } as KeyboardEventInit);
    }
    expect(changes).toEqual([]);
    target.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
    expect(changes).toEqual(["| 名 | 值 |\n|---|---|\n| 中 | 1 |\n"]);
  });

  it("keeps Enter and Tab for the IME while composing", () => {
    const text = "| a | b |\n|---|---|\n| c | d |\n";
    const { editor, cell } = open(text);
    cell(1, 1).focus();
    cell(1, 1).dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    press("Tab", { isComposing: true });
    press("Enter", { isComposing: true });
    expect(focusedCell()).toBe("1:1");
    expect(editor.getText()).toBe(text);
  });
});

describe("table commands", () => {
  const text = "intro\n\n| a  | b |\n|----|--:|\n| c  | d |\n\nend\n";

  it("act on the cell at the cursor, also in source mode", () => {
    const { editor } = open(text, { mode: "source" });
    editor.setSelection({ anchor: text.indexOf("c ") });
    expect(editor.execute("insertTableRow", "below")).toBe(true);
    expect(editor.getText()).toBe(
      "intro\n\n| a  | b |\n|----|--:|\n| c  | d |\n|    |   |\n\nend\n",
    );
    expect(editor.execute("deleteTableRow")).toBe(true);
    expect(editor.getText()).toBe(text);
    expect(editor.execute("insertTableColumn", "left")).toBe(true);
    expect(editor.getText()).toBe(
      "intro\n\n|     | a  | b |\n| --- |----|--:|\n|     | c  | d |\n\nend\n",
    );
    // The cursor moved into the new column, so this deletes it again.
    expect(editor.execute("deleteTableColumn")).toBe(true);
    expect(editor.getText()).toBe(text);
    editor.setSelection({ anchor: text.indexOf("d ") });
    expect(editor.execute("setTableAlignment", "none")).toBe(true);
    expect(editor.getText()).toBe(text.replace("--:", "---"));
  });

  it("act on the focused cell of a table widget", () => {
    const { editor, cell } = open(text);
    cell(1, 1).focus();
    expect(editor.execute("setTableAlignment", "center")).toBe(true);
    expect(editor.getText()).toBe(text.replace("--:", ":-:"));
  });

  it("do nothing outside a table", () => {
    const { editor } = open(text);
    editor.setSelection({ anchor: 2 });
    for (const run of [
      () => editor.execute("insertTableRow", "above"),
      () => editor.execute("deleteTableRow"),
      () => editor.execute("insertTableColumn", "right"),
      () => editor.execute("deleteTableColumn"),
      () => editor.execute("setTableAlignment", "left"),
      () => editor.execute("formatTable"),
    ])
      expect(run()).toBe(false);
    expect(editor.getText()).toBe(text);
  });
});

describe("format table", () => {
  it("realigns the whole table, counting CJK characters as two columns wide", () => {
    const text = "x\n\n| Name | Qty |\n|:-|-:|\n| 苹果 | 3 |\n| pear|12|\n\ny\n";
    const { editor } = open(text, { mode: "source" });
    editor.setSelection({ anchor: text.indexOf("pear") });
    expect(editor.execute("formatTable")).toBe(true);
    expect(editor.getText()).toBe(
      "x\n\n| Name | Qty |\n| :--- | --: |\n| 苹果 |   3 |\n| pear |  12 |\n\ny\n",
    );
  });

  it("adds outer pipes, pads short rows and centers centered columns", () => {
    const text = "a | bb\n--|:-:\nccccc\n";
    const { editor } = open(text, { mode: "source" });
    editor.setSelection({ anchor: 0 });
    editor.execute("formatTable");
    expect(editor.getText()).toBe("| a     | bb  |\n| ----- | :-: |\n| ccccc |     |\n");
  });

  it("is a toolbar action, and leaves an already formatted table unchanged", () => {
    const text = "| a   | b   |\n| --- | --- |\n| c   | d   |\n";
    const { editor, cell, table } = open(text);
    const changes: unknown[] = [];
    editor.subscribe((event) => {
      if (event.type === "change") changes.push(event);
    });
    cell(1, 1).focus();
    table().querySelector<HTMLElement>('[data-mint-action="format"]')?.click();
    expect(editor.getText()).toBe(text);
    expect(changes).toEqual([]);
  });
});

describe("insert table", () => {
  const empty3x2 =
    "|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |";

  it("inserts an empty table after the cursor's paragraph and puts the focus in its first cell", () => {
    const { editor, cell } = open("Hello\nworld");
    editor.setSelection({ anchor: 2 });
    expect(editor.execute("insertTable")).toBe(true);
    expect(editor.getText()).toBe(`Hello\n\n${empty3x2}\n\nworld`);
    expect(focusedCell()).toBe("0:0");
    typeInto(cell(0, 0), "Name");
    expect(editor.getText()).toBe(`Hello\n\n${empty3x2.replace("|     |", "| Name |")}\n\nworld`);
  });

  it("uses an empty line as it is, keeping blank lines around the table", () => {
    const { editor } = open("a\n\n\nb");
    editor.setSelection({ anchor: 2 });
    editor.execute("insertTable", 2, 1);
    expect(editor.getText()).toBe("a\n\n|     |     |\n| --- | --- |\n|     |     |\n\nb");
  });

  it("works in an empty document, leaving the cursor below the table", () => {
    const { editor } = open("", { mode: "source" });
    editor.execute("insertTable", 1, 0);
    expect(editor.getText()).toBe("|     |\n| --- |\n");
    expect(editor.getSelection().anchor).toBe(editor.getText().length);
  });
});
