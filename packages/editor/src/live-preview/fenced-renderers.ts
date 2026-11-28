import { type Extension, Prec } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import { previewRenderer } from "./preview.ts";

/** A host-supplied preview of a top-level fenced code block. */
export interface CodeBlockRenderer {
  readonly language: string;
  render(source: string): HTMLElement;
}

class FenceWidget extends WidgetType {
  constructor(
    readonly renderer: CodeBlockRenderer,
    readonly source: string,
  ) {
    super();
  }

  override eq(other: FenceWidget) {
    return this.renderer === other.renderer && this.source === other.source;
  }

  toDOM(view: EditorView) {
    const dom = this.renderer.render(this.source);
    dom.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(dom) } });
      view.focus();
    });
    return dom;
  }
}

export function fencedRenderers(renderers: readonly CodeBlockRenderer[]): Extension {
  return renderers.map((renderer) =>
    Prec.high(
      previewRenderer.of({
        nodes: ["FencedCode"],
        scope: "block",
        matches(node, state) {
          const info = node.getChild("CodeInfo");
          return (
            !!info &&
            state.sliceDoc(info.from, info.to).split(/\s/)[0]?.toLowerCase() ===
              renderer.language &&
            state.doc.lineAt(node.from).from === node.from &&
            state.doc.lineAt(node.to).to === node.to
          );
        },
        render(node, cx) {
          if (cx.touchesSelectedLines(node.from, node.to)) return;
          const source = node
            .getChildren("CodeText")
            .map(({ from, to }) => cx.state.sliceDoc(from, to))
            .join("");
          cx.add(
            node.from,
            node.to,
            Decoration.replace({ widget: new FenceWidget(renderer, source), block: true }),
          );
          return false;
        },
      }),
    ),
  );
}
