import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type Dialect, htmlToMarkdown } from "@mint/markdown";

/** Where pasted text is source code or TeX, kept as typed rather than read as rich text. */
const literalNodes = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "BlockMath",
  "InlineMath",
  "FrontMatter",
  "HTMLBlock",
]);

function inLiteral(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node.parent; node = node.parent) {
    if (literalNodes.has(node.name)) return true;
  }
  return false;
}

/** Insert text as a paste: one undo step, line breaks in the document's line ending. */
export function pasteText(view: EditorView, text: string): void {
  view.dispatch(view.state.replaceSelection(text), {
    userEvent: "input.paste",
    scrollIntoView: true,
  });
}

/**
 * Markdown for rich text from the clipboard, or `null` to paste its plain text.
 * A single line (an inline fragment) goes into the current line as is.
 */
function markdownFor(data: DataTransfer, dialect: Dialect): string | null {
  const html = data.getData("text/html");
  // Code editors (VS Code and its relatives) put coloured HTML next to the code itself.
  if (!html || [...data.types].includes("vscode-editor-data")) return null;
  const markdown = htmlToMarkdown(html, dialect);
  if (markdown === "") return null;
  const body = markdown.replace(/\n$/, "");
  return body.includes("\n") ? markdown : body;
}

/**
 * Pasting rich text (HTML on the clipboard) inserts it as Markdown in the
 * editor's dialect. Pastes into code, math and front matter, and clipboards
 * without HTML, keep the default plain text paste; image files are left to
 * the image handling.
 */
export function richPaste(dialect: Dialect): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData;
      if (!data || [...data.files].some((file) => file.type.startsWith("image/"))) return false;
      if (view.state.selection.ranges.some((range) => inLiteral(view.state, range.from))) {
        return false;
      }
      const markdown = markdownFor(data, dialect);
      if (markdown === null) return false;
      event.preventDefault();
      pasteText(view, markdown);
      return true;
    },
  });
}
