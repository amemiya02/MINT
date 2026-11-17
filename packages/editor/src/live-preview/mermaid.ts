import { type EditorState, type Extension, Prec } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { Mermaid } from "mermaid";
import { type PreviewRenderer, previewRenderer } from "./preview.ts";

/**
 * Mermaid block widget: a ` ```mermaid ` code block is shown as the diagram
 * it describes, and as its source while the cursor is on one of its lines.
 * It takes precedence over the generic code block renderer for these blocks.
 *
 * Mermaid is large, so it is loaded on first use (a separate chunk), never on
 * the startup path.
 */

/** The result of rendering a diagram: its SVG, or the syntax error. */
type Diagram = { readonly svg: string } | { readonly error: string };

let library: Promise<Mermaid> | undefined;
function loadMermaid(): Promise<Mermaid> {
  library ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    return mermaid;
  });
  return library;
}

let renders = 0;
async function renderDiagram(source: string): Promise<Diagram> {
  const id = `mint-mermaid-${++renders}`;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(id, source);
    return { svg };
  } catch (error) {
    // On a syntax error Mermaid leaves its error graphic in the document.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Rendered diagrams by source, so unchanged diagrams are not rendered again. */
const cache = new Map<string, Promise<Diagram>>();
const cacheLimit = 64;
function diagramFor(source: string): Promise<Diagram> {
  let diagram = cache.get(source);
  if (diagram) {
    cache.delete(source); // keep recently used entries last
  } else {
    diagram = renderDiagram(source);
    const oldest = cache.keys().next();
    if (cache.size >= cacheLimit && !oldest.done) cache.delete(oldest.value);
  }
  cache.set(source, diagram);
  return diagram;
}

/**
 * Render a Mermaid diagram's source to SVG, as the Mermaid block widget shows
 * it (for exporting documents). Rejects with the syntax error.
 */
export async function renderMermaid(source: string): Promise<string> {
  const diagram = await diagramFor(source);
  if ("error" in diagram) throw new Error(diagram.error);
  return diagram.svg;
}

function show(dom: HTMLElement, diagram: Diagram) {
  if ("svg" in diagram) {
    dom.dataset.state = "rendered";
    dom.innerHTML = diagram.svg;
  } else {
    dom.dataset.state = "error";
    const message = document.createElement("div");
    message.className = "cm-mint-mermaid-error";
    message.setAttribute("role", "alert");
    message.textContent = `Mermaid: ${diagram.error}`;
    dom.replaceChildren(message);
  }
}

class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  override eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }

  override get estimatedHeight(): number {
    return 160;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-mint-mermaid";
    dom.dataset.state = "loading";
    void diagramFor(this.source).then((diagram) => {
      show(dom, diagram);
      view.requestMeasure();
    });
    // Clicking the diagram moves the cursor into the block: its source shows.
    dom.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(dom) } });
      view.focus();
    });
    return dom;
  }
}

function isMermaidBlock(node: SyntaxNode, state: EditorState): boolean {
  const info = node.getChild("CodeInfo");
  if (!info) return false;
  const language = state.sliceDoc(info.from, info.to).trim().split(/\s/)[0] ?? "";
  return language.toLowerCase() === "mermaid";
}

const renderer: PreviewRenderer = {
  nodes: ["FencedCode"],
  scope: "block",
  matches: isMermaidBlock,
  render(node, cx) {
    const { doc } = cx.state;
    // Block widgets replace whole lines; fences inside containers (lists,
    // quotes) do not start their line and stay as source.
    if (doc.lineAt(node.from).from !== node.from || doc.lineAt(node.to).to !== node.to) return;
    if (cx.touchesSelectedLines(node.from, node.to)) return;
    const code = node.getChild("CodeText");
    const source = code ? cx.state.sliceDoc(code.from, code.to) : "";
    cx.add(
      node.from,
      node.to,
      Decoration.replace({ widget: new MermaidWidget(source), block: true }),
    );
    return false;
  },
};

const theme = EditorView.baseTheme({
  ".cm-mint-mermaid": {
    display: "flex",
    justifyContent: "center",
    padding: "8px 0",
    cursor: "text",
  },
  ".cm-mint-mermaid[data-state=loading]": { minHeight: "80px" },
  ".cm-mint-mermaid svg": { maxWidth: "100%", height: "auto" },
  ".cm-mint-mermaid-error": {
    width: "100%",
    padding: "8px 12px",
    borderRadius: "4px",
    whiteSpace: "pre-wrap",
    fontFamily: "var(--mint-font-code, monospace)",
    fontSize: "0.85em",
    color: "var(--mint-error-fg, #b42318)",
    backgroundColor: "var(--mint-error-bg, rgba(180, 35, 24, 0.08))",
  },
});

/** Render ` ```mermaid ` code blocks as diagrams (dialect switch `mermaid`). */
export function mermaidDiagrams(): Extension {
  return [Prec.high(previewRenderer.of(renderer)), theme];
}
