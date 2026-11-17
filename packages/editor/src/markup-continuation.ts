import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
} from "@codemirror/lang-markdown";
import { type Extension, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";

/**
 * Enter continues the list item, task item or block quote at the cursor; on an
 * empty item it ends the list instead (without turning a tight list loose).
 * Backspace right after a list or quote marker removes the marker.
 */
export const markupContinuation: Extension = Prec.high(
  keymap.of([
    { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
    { key: "Backspace", run: deleteMarkupBackward },
  ]),
);
