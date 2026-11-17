// Source fidelity of the table block widget, as properties over random tables:
// every widget operation must map to the smallest text change. The oracle is
// the generator itself, which knows where each row and cell of the table is,
// and a fresh editor opened on the result, which shows how it parses.
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createEditor, type MintEditor } from "../src/index.ts";
import { finishParsing } from "./parsed.ts";

const editors: { editor: MintEditor; parent: HTMLElement }[] = [];
function closeAll() {
  for (const { editor, parent } of editors.splice(0)) {
    editor.destroy();
    parent.remove();
  }
}
afterEach(closeAll);
/** Open a text in a fresh editor; a property run needs one at a time, so earlier ones are closed. */
function open(text: string) {
  closeAll();
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text });
  editors.push({ editor, parent });
  finishParsing(parent);
  editor.setSelection({ anchor: text.length });
  const cell = (row: number, column: number) => {
    const element = parent.querySelector<HTMLElement>(`[data-mint-cell="${row}:${column}"]`);
    if (!element) throw new Error(`No cell ${row}:${column}`);
    return element;
  };
  const action = (name: string) => {
    const button = parent.querySelector<HTMLElement>(`[data-mint-action="${name}"]`);
    if (!button) throw new Error(`No action ${name}`);
    button.click();
  };
  return { editor, parent, cell, action };
}
/** The cells of the table a text renders, as their source, in an editor that is closed right away. */
function gridOf(text: string): string[][] {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createEditor({ parent, text });
  finishParsing(parent);
  editor.setSelection({ anchor: text.length });
  // A cell shows its Markdown source while it has focus.
  const grid = [...parent.querySelectorAll(".cm-mint-table tr")].map((row) =>
    [...row.querySelectorAll<HTMLElement>("[data-mint-cell]")].map((c) => {
      c.focus();
      return c.textContent ?? "";
    }),
  );
  editor.destroy();
  parent.remove();
  return grid;
}

function typeInto(cell: HTMLElement, text: string) {
  cell.focus();
  cell.textContent = text;
  cell.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

// -- random tables ------------------------------------------------------------

const content = fc
  .array(fc.constantFrom("a", "b", "中", "文", "😀", "*", "`", "\\|", " ", "x"), {
    maxLength: 5,
  })
  .map((units) => units.join("").trim());
const padding = fc.constantFrom("", " ", "  ", "   ");

interface Segment {
  readonly text: string;
  readonly left: string;
  readonly right: string;
}
const segment = (text: fc.Arbitrary<string>) => fc.record({ text, left: padding, right: padding });

interface GeneratedTable {
  readonly leading: boolean;
  readonly trailing: boolean;
  readonly header: Segment[];
  readonly delimiter: Segment[];
  readonly body: Segment[][];
}

const delimiterCell = fc
  .record({ dashes: fc.integer({ min: 1, max: 5 }), left: fc.boolean(), right: fc.boolean() })
  .map(({ dashes, left, right }) => `${left ? ":" : ""}${"-".repeat(dashes)}${right ? ":" : ""}`);

const generatedTable: fc.Arbitrary<GeneratedTable> = fc
  .integer({ min: 1, max: 4 })
  .chain((columns) =>
    fc.record({
      leading: fc.boolean(),
      trailing: fc.boolean(),
      header: fc.array(segment(content), { minLength: columns, maxLength: columns }),
      delimiter: fc.array(segment(delimiterCell), { minLength: columns, maxLength: columns }),
      body: fc.array(
        fc.array(segment(content), { minLength: Math.max(1, columns - 1), maxLength: columns + 1 }),
        { maxLength: 4 },
      ),
    }),
  )
  .map((t) => {
    // A row needs at least one pipe, and a row without a leading pipe must not
    // start like another block (a list item, a fence): start it with a letter.
    // Without a trailing pipe, a blank last cell would read as one: end it with a letter.
    // A one-column delimiter row needs a pipe after its cell.
    const trailing = t.trailing || t.header.length === 1;
    const safe = (rows: Segment[][]) =>
      rows.map((cells) =>
        cells.map((c, i) => {
          let text = c.text;
          if (!t.leading && i === 0 && !text.startsWith("x")) text = `x${text}`;
          if (!trailing && i === cells.length - 1 && !text) text = "y";
          return { ...c, text };
        }),
      );
    const [header = [], ...body] = safe([t.header, ...t.body]);
    // `- |` would start a list item.
    const delimiter = t.leading
      ? t.delimiter
      : t.delimiter.map((d, i) => (i === 0 ? { text: "---", left: "", right: d.right } : d));
    return { ...t, trailing, header, body, delimiter };
  });

interface Layout {
  readonly text: string;
  /** For each row (header first), each cell's segment [from, to]. */
  readonly cells: [number, number][][];
  /** For each row (header first), the line's [from, to]. */
  readonly lines: [number, number][];
}

/** Lay a table out as text between two paragraphs, remembering where everything is. */
function layout(table: GeneratedTable): Layout {
  let text = "before\n\n";
  const cells: [number, number][][] = [];
  const lines: [number, number][] = [];
  const row = (segments: Segment[], record: boolean) => {
    const start = text.length;
    const positions: [number, number][] = [];
    // A short body row without leading pipe and with a single cell still needs a pipe.
    const trailing = table.trailing || (!table.leading && segments.length === 1);
    if (table.leading) text += "|";
    segments.forEach((s, i) => {
      if (i > 0) text += "|";
      const from = text.length;
      text += s.left + s.text + s.right;
      positions.push([from, text.length]);
    });
    if (trailing) text += "|";
    if (record) {
      cells.push(positions);
      lines.push([start, text.length]);
    }
    text += "\n";
  };
  row(table.header, true);
  row(
    table.delimiter.map((d) => d),
    false,
  );
  for (const r of table.body) row(r, true);
  text += "\nafter\n";
  return { text, cells, lines };
}

/** What a cell shows once the user typed `value` into it. */
function shown(value: string): string {
  return value.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
}

const typed = fc
  .array(fc.constantFrom("a", "Z", "中", "😀", " ", "|", "\n", "*", "1"), { maxLength: 6 })
  .map((units) => units.join(""));

// Every redraw of a table runs the export pipeline; give the properties time on loaded machines.
describe("table widget source fidelity", () => {
  it("renders every generated table as the grid it describes", () => {
    fc.assert(
      fc.property(generatedTable, (table) => {
        const columns = table.header.length;
        const expected = [table.header, ...table.body].map((cells) =>
          Array.from({ length: columns }, (_, i) => cells[i]?.text ?? ""),
        );
        expect(gridOf(layout(table).text)).toEqual(expected);
      }),
      { numRuns: 50 },
    );
  }, 120_000);

  it("editing a cell changes only that cell's segment, and only that cell's content", () => {
    fc.assert(
      fc.property(generatedTable, fc.nat(), fc.nat(), typed, (table, r, c, value) => {
        const { text, cells, lines } = layout(table);
        const rows = 1 + table.body.length;
        const columns = table.header.length;
        const row = r % rows;
        const column = c % columns;
        const before = gridOf(text);

        const view = open(text);
        typeInto(view.cell(row, column), value);
        const after = view.editor.getText();

        // Outside the cell's segment (or, for a cell missing from a short row,
        // the end of its line) nothing changed.
        const line = lines[row] as [number, number];
        const own = cells[row]?.[column];
        const [from, to] = own ?? [cells[row]?.at(-1)?.[1] ?? line[0], line[1]];
        expect(after.slice(0, from)).toBe(text.slice(0, from));
        expect(after.slice(after.length - (text.length - to))).toBe(text.slice(to));
        expect(after.slice(from, after.length - (text.length - to))).not.toContain("\n");

        const expected = before.map((cellsOfRow) => [...cellsOfRow]);
        (expected[row] as string[])[column] = shown(value);
        expect(gridOf(after)).toEqual(expected);
      }),
      { numRuns: 50 },
    );
  }, 120_000);

  const lines = (text: string) => text.split("\n");
  /** `after` is `before` with characters only added, and only characters from `allowed`. */
  const onlyAdds = (before: string, after: string, allowed: RegExp) => {
    let i = 0;
    for (const ch of after) {
      if (ch === before.slice(i, i + ch.length)) i += ch.length;
      else if (!allowed.test(ch)) return false;
    }
    return i === before.length;
  };
  /** `after` is `before` without one contiguous piece (and maybe a pipe appended). */
  const oneCut = (before: string, after: string) => {
    const target = after.endsWith("|") && !before.endsWith("|") ? after.slice(0, -1) : after;
    for (let from = 0; from <= target.length; from++) {
      const cut = before.length - target.length;
      if (
        before.slice(0, from) === target.slice(0, from) &&
        before.slice(from + cut) === target.slice(from)
      )
        return true;
    }
    return false;
  };

  it("row, column and alignment operations change only what they must", () => {
    const actions = [
      "addRowAbove",
      "addRowBelow",
      "deleteRow",
      "addColumnLeft",
      "addColumnRight",
      "deleteColumn",
      "alignLeft",
      "alignCenter",
      "alignRight",
    ] as const;
    fc.assert(
      fc.property(
        generatedTable,
        fc.nat(),
        fc.nat(),
        fc.constantFrom(...actions),
        (table, r, c, action) => {
          const { text } = layout(table);
          const rows = 1 + table.body.length;
          const columns = table.header.length;
          const row = r % rows;
          const column = c % columns;
          const before = gridOf(text);
          const view = open(text);
          view.cell(row, column).focus();
          view.action(action);
          const after = view.editor.getText();
          const grid = gridOf(after);
          const [oldLines, newLines] = [lines(text), lines(after)];
          // The header row is line 2, the delimiter row line 3, body rows follow.
          const lineOf = (tableRow: number) => (tableRow === 0 ? 2 : tableRow + 3);

          if (action === "addRowAbove" || action === "addRowBelow") {
            const at = action === "addRowAbove" ? Math.max(1, row) : row + 1;
            const expected = [...before];
            expected.splice(at, 0, Array<string>(columns).fill(""));
            expect(grid).toEqual(expected);
            const added = lineOf(at);
            expect(newLines.filter((_, i) => i !== added)).toEqual(oldLines);
          } else if (action === "deleteRow") {
            if (row === 0) {
              expect(after).toBe(text);
            } else {
              expect(grid).toEqual(before.filter((_, i) => i !== row));
              expect(newLines).toEqual(oldLines.filter((_, i) => i !== lineOf(row)));
            }
          } else if (action === "addColumnLeft" || action === "addColumnRight") {
            const at = action === "addColumnLeft" ? column : column + 1;
            expect(grid).toEqual(before.map((cells) => cells.toSpliced(at, 0, "")));
            expect(newLines).toHaveLength(oldLines.length);
            newLines.forEach((line, i) => {
              expect(onlyAdds(oldLines[i] ?? "", line, /[| -]/), `${oldLines[i]} → ${line}`).toBe(
                true,
              );
            });
          } else if (action === "deleteColumn") {
            if (columns === 1) {
              expect(after).toBe(text);
            } else {
              expect(grid).toEqual(before.map((cells) => cells.toSpliced(column, 1)));
              newLines.forEach((line, i) => {
                expect(oneCut(oldLines[i] ?? "", line), `${oldLines[i]} → ${line}`).toBe(true);
              });
            }
          } else {
            const alignment = { alignLeft: "left", alignCenter: "center", alignRight: "right" }[
              action
            ];
            expect(grid).toEqual(before);
            newLines.forEach((line, i) => {
              if (i !== 3) expect(line).toBe(oldLines[i]);
            });
            const header = open(after).cell(0, column).closest("th");
            expect(header?.style.textAlign).toBe(alignment);
          }
        },
      ),
      { numRuns: 50 },
    );
  }, 120_000);
});
