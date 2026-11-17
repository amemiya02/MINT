import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

/**
 * CodeMirror parses a new document for a short time slice and finishes in the
 * background, so on a loaded machine the syntax tree (and with it every block
 * widget) may arrive a moment later. Tests that look at block widgets right
 * after mounting finish the parse first. It takes effect with the next
 * transaction, such as setting the selection.
 */
export function finishParsing(parent: HTMLElement): void {
  const dom = parent.querySelector<HTMLElement>(".cm-editor");
  const view = dom && EditorView.findFromDOM(dom);
  if (view) ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
}
