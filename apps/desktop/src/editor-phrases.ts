import type { tablePhrases } from "@mint/editor";
import type { MessageKey, Translate } from "./i18n/index.ts";

/**
 * The editor core's own UI copy is keyed by its English text; this maps each
 * phrase to an i18n key, and type-checks that every phrase is translated.
 */
const keys: Record<(typeof tablePhrases)[number], MessageKey> = {
  "Insert row above": "editor.table.insertRowAbove",
  "Insert row below": "editor.table.insertRowBelow",
  "Delete row": "editor.table.deleteRow",
  "Insert column left": "editor.table.insertColumnLeft",
  "Insert column right": "editor.table.insertColumnRight",
  "Delete column": "editor.table.deleteColumn",
  "Align left": "editor.table.alignLeft",
  "Align center": "editor.table.alignCenter",
  "Align right": "editor.table.alignRight",
  "Format table": "editor.table.format",
  "Edit table source": "editor.table.editSource",
};

/** Phrases for `createEditor`, in the UI language. */
export function editorPhrases(t: Translate): Record<string, string> {
  return Object.fromEntries(Object.entries(keys).map(([phrase, key]) => [phrase, t(key)]));
}
