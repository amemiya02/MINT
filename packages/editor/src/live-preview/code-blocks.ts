import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type PreviewContext, type PreviewRenderer, previewRenderer } from "./preview.ts";

/** The fenced code block around `pos`, if any. */
function fencedCodeAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, pos, 200) ?? syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === "FencedCode") return node;
    }
  }
  return null;
}

/** Where a block's language (info string) is, or would be inserted. */
function infoRange(block: SyntaxNode): { from: number; to: number } | null {
  const info = block.getChild("CodeInfo");
  if (info) return { from: info.from, to: info.to };
  const fence = block.getChild("CodeMark");
  return fence && fence.from === block.from ? { from: fence.to, to: fence.to } : null;
}

/**
 * Set the language of the fenced code block at the cursor. Only the info
 * string changes. Returns false when the cursor is not in a fenced code block.
 */
export function setCodeBlockLanguage(view: EditorView, language: string): boolean {
  const block = fencedCodeAt(view.state, view.state.selection.main.head);
  const range = block && infoRange(block);
  if (!range) return false;
  const insert = language.trim().replace(/\s+/g, "-");
  if (view.state.sliceDoc(range.from, range.to) === insert) return true;
  view.dispatch({ changes: { ...range, insert }, userEvent: "input.language" });
  return true;
}

/** The language label shown in place of the opening fence. Clicking it selects the language for editing. */
class LanguageLabel extends WidgetType {
  constructor(readonly language: string) {
    super();
  }
  override eq(other: LanguageLabel) {
    return other.language === this.language;
  }
  toDOM(view: EditorView) {
    const label = document.createElement("span");
    label.className = "cm-mint-code-language";
    label.textContent = this.language;
    label.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const block = fencedCodeAt(view.state, view.posAtDOM(label));
      const range = block && infoRange(block);
      if (!range) return;
      view.dispatch({ selection: EditorSelection.single(range.from, range.to) });
      view.focus();
    });
    return label;
  }
  override ignoreEvent() {
    return true;
  }
}

export const codeBlockPhrases = ["Copy code block", "Copied", "Copy failed"] as const;

class CopyCodeButton extends WidgetType {
  constructor(readonly writeClipboardText: (text: string) => Promise<void>) {
    super();
  }

  toDOM(view: EditorView) {
    const control = document.createElement("span");
    control.className = "cm-mint-copy-code";
    const button = document.createElement("button");
    button.type = "button";
    button.title = view.state.phrase("Copy code block");
    button.setAttribute("aria-label", button.title);
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    control.append(button, status);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // A mouse click should leave the editor's selection in place.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", async () => {
      const block = fencedCodeAt(view.state, view.posAtDOM(control));
      if (!block) return;
      // In containers, the code text ranges skip quote and list markers.
      const code = block
        .getChildren("CodeText")
        .map(({ from, to }) => view.state.sliceDoc(from, to));
      const current = ++attempt;
      let message: (typeof codeBlockPhrases)[number];
      try {
        await this.writeClipboardText(code.join(""));
        message = "Copied";
      } catch {
        message = "Copy failed";
      }
      if (current !== attempt || !control.isConnected) return;
      clearTimeout(timer);
      status.textContent = view.state.phrase(message);
      timer = setTimeout(() => {
        status.textContent = "";
      }, 2000);
    });
    return control;
  }
}

const codeLine = Decoration.line({ class: "cm-mint-codeblock" });
const openingLine = Decoration.line({ class: "cm-mint-codeblock cm-mint-codeblock-opening" });

function render(block: SyntaxNode, cx: PreviewContext, copyButton: Decoration) {
  const { doc } = cx.state;
  const first = doc.lineAt(block.from);
  const last = doc.lineAt(block.to);
  cx.line(first.from, openingLine);
  for (let n = first.number + 1; n <= last.number; n++) cx.line(doc.line(n).from, codeLine);
  cx.add(block.from, block.from, copyButton);
  // Like other block widgets, the source comes back while the cursor is in the block.
  if (cx.touchesSelectedLines(block.from, block.to)) return;

  const info = block.getChild("CodeInfo");
  const opening = { from: block.from, to: first.to };
  if (info) {
    const language = doc.sliceString(info.from, info.to).split(/\s/)[0] ?? "";
    cx.add(opening.from, opening.to, Decoration.replace({ widget: new LanguageLabel(language) }));
  } else {
    cx.hide(opening.from, opening.to);
  }
  const closing = block.getChildren("CodeMark").find((mark) => mark.from > first.to);
  if (closing) cx.hide(doc.lineAt(closing.from).from, closing.to);
}

const theme = EditorView.baseTheme({
  ".cm-mint-codeblock": {
    fontFamily: "var(--mint-font-code, monospace)",
    paddingLeft: "0.8em",
    position: "relative",
    // CodeMirror draws selections below the text. Paint the background below that layer.
    "&::before": {
      content: '""',
      position: "absolute",
      inset: "0",
      zIndex: "-3",
      pointerEvents: "none",
      backgroundColor: "var(--mint-code-bg, rgba(127, 127, 127, 0.1))",
    },
  },
  ".cm-mint-code-language": {
    float: "right",
    marginInlineEnd: "0.4em",
    cursor: "pointer",
    fontSize: "0.8em",
    color: "var(--mint-marker, #8a9099)",
  },
  ".cm-mint-codeblock-opening": { display: "flow-root" },
  ".cm-mint-copy-code": {
    float: "right",
    position: "relative",
    display: "inline-flex",
    marginInlineEnd: "0.25em",
    "& button": {
      display: "grid",
      placeContent: "center",
      minInlineSize: "24px",
      minBlockSize: "24px",
      padding: "0",
      border: "0",
      borderRadius: "4px",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
      "&:hover, &:focus-visible": {
        backgroundColor: "var(--mint-hover, rgba(127, 127, 127, 0.15))",
      },
      "&::before": {
        content: '""',
        width: "9px",
        height: "11px",
        border: "1px solid currentColor",
        borderRadius: "2px",
        boxShadow: "-3px -3px 0 -1px var(--mint-code-bg, Canvas), -3px -3px 0 currentColor",
      },
    },
    "& [role=status]": {
      position: "absolute",
      insetBlockStart: "100%",
      insetInlineEnd: "0",
      zIndex: "1",
      padding: "2px 6px",
      borderRadius: "4px",
      backgroundColor: "var(--mint-fg, CanvasText)",
      color: "var(--mint-bg, Canvas)",
      fontSize: "0.8em",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      "&:empty": { opacity: "0" },
    },
  },
});

/** Fenced code blocks: background, language label and copy button. */
export function codeBlocks(
  writeClipboardText: (text: string) => Promise<void> = (text) =>
    navigator.clipboard.writeText(text),
): Extension {
  const copyButton = Decoration.widget({
    widget: new CopyCodeButton(writeClipboardText),
    side: -1,
  });
  const renderer: PreviewRenderer = {
    nodes: ["FencedCode"],
    render(node, cx) {
      render(node, cx, copyButton);
      return false;
    },
  };
  return [previewRenderer.of(renderer), theme];
}
