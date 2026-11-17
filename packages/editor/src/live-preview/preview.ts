import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/**
 * Live preview: the document stays the Markdown source, and syntax nodes are
 * rendered in place with CodeMirror decorations. Rendering never changes the
 * text, so source fidelity holds by construction.
 *
 * Each kind of syntax is rendered by a {@link PreviewRenderer}, registered
 * with {@link previewRenderer}. The engine walks the syntax tree, calls the
 * renderer for every node it claims, and tells it whether the selection
 * touches that node (span reveal). Inline renderers run over the visible
 * part of the document only; block renderers (block widgets) run over the
 * whole document because CodeMirror only accepts block decorations from
 * state, not from view plugins.
 */
export interface PreviewRenderer {
  /** Syntax node names (Lezer Markdown) this renderer draws. */
  readonly nodes: readonly string[];
  /**
   * `inline` (the default): decorations stay within a line; rendered for the
   * viewport only. `block`: may replace whole blocks or add block widgets;
   * rendered for the whole document.
   */
  readonly scope?: "inline" | "block";
  /**
   * Whether this renderer draws `node` (default: every node named in
   * `nodes`). When several renderers claim a node, the first one in facet
   * order (highest precedence first) that matches draws it, in its own
   * scope; the others leave it alone. This lets a specific renderer (a
   * Mermaid diagram) take over some nodes of a generic one (code blocks).
   */
  matches?(node: SyntaxNode, state: EditorState): boolean;
  /**
   * Add decorations for one node. Return `false` to skip the node's
   * descendants (for example when the whole block is replaced by a widget).
   */
  render(node: SyntaxNode, context: PreviewContext): boolean | undefined;
}

export interface PreviewContext {
  readonly state: EditorState;
  /** Whether any selection range touches `from`–`to`, boundaries included: the span should be revealed. */
  touchesSelection(from: number, to: number): boolean;
  /** Whether any selection range touches a line of `from`–`to`: the block should be revealed. */
  touchesSelectedLines(from: number, to: number): boolean;
  /** Add a decoration. Empty ranges are ignored unless the decoration carries a widget. */
  add(from: number, to: number, decoration: Decoration): void;
  /** Add a line decoration (`Decoration.line`) to the line containing `pos`. */
  line(pos: number, decoration: Decoration): void;
  /**
   * Hide `from`–`to` (a Markdown marker) without changing the text. Line
   * breaks inside the range stay visible: only the text on each line is hidden.
   */
  hide(from: number, to: number): void;
}

/** Register a renderer with live preview. */
export const previewRenderer = Facet.define<PreviewRenderer>();

const hidden = Decoration.replace({});

function build(
  state: EditorState,
  scope: "inline" | "block",
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  // Renderers of every scope, so that precedence holds across scopes.
  const byNode = new Map<string, PreviewRenderer[]>();
  let any = false;
  for (const renderer of state.facet(previewRenderer)) {
    any ||= (renderer.scope ?? "inline") === scope;
    for (const name of renderer.nodes) {
      const list = byNode.get(name);
      if (list) list.push(renderer);
      else byNode.set(name, [renderer]);
    }
  }
  if (!any) return Decoration.none;

  const decorations: Range<Decoration>[] = [];
  const selection = state.selection.ranges;
  const context: PreviewContext = {
    state,
    touchesSelection: (from, to) => selection.some((r) => r.from <= to && r.to >= from),
    touchesSelectedLines(from, to) {
      const start = state.doc.lineAt(from).from;
      const end = state.doc.lineAt(to).to;
      return selection.some((r) => r.from <= end && r.to >= start);
    },
    add(from, to, decoration) {
      if (to > from || decoration.spec.widget) decorations.push(decoration.range(from, to));
    },
    line(pos, decoration) {
      const start = state.doc.lineAt(pos).from;
      decorations.push(decoration.range(start, start));
    },
    hide(from, to) {
      for (let pos = from; pos < to; ) {
        const line = state.doc.lineAt(pos);
        const end = Math.min(to, line.to);
        if (end > pos) decorations.push(hidden.range(pos, end));
        pos = line.to + 1;
      }
    },
  };

  const tree = syntaxTree(state);
  for (const { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter(ref) {
        const candidates = byNode.get(ref.name);
        if (!candidates) return;
        const node = ref.node;
        const renderer = candidates.find((r) => r.matches?.(node, state) ?? true);
        if (!renderer || (renderer.scope ?? "inline") !== scope) return;
        return renderer.render(node, context) !== false;
      },
    });
  }
  return Decoration.set(decorations, true);
}

function needsRebuild(update: ViewUpdate | Transaction, startState: EditorState): boolean {
  const state = update.state;
  return (
    update.docChanged ||
    !state.selection.eq(startState.selection) ||
    syntaxTree(state) !== syntaxTree(startState) ||
    state.facet(previewRenderer) !== startState.facet(previewRenderer)
  );
}

const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    stale = false;
    constructor(view: EditorView) {
      this.decorations = build(view.state, "inline", view.visibleRanges);
    }
    update(update: ViewUpdate) {
      // Never touch decorations under an IME composition: rebuilding them can
      // cancel it. They are rebuilt by the first update after it ends.
      if (update.view.composing) {
        this.decorations = this.decorations.map(update.changes);
        this.stale ||= update.docChanged || update.selectionSet;
      } else if (this.stale || needsRebuild(update, update.startState) || update.viewportChanged) {
        this.stale = false;
        this.decorations = build(update.state, "inline", update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const blockPreview = StateField.define<DecorationSet>({
  create: (state) => build(state, "block", [{ from: 0, to: state.doc.length }]),
  update(decorations, tr) {
    if (!needsRebuild(tr, tr.startState)) return decorations;
    return build(tr.state, "block", [{ from: 0, to: tr.state.doc.length }]);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const previewTheme = EditorView.baseTheme({
  ".cm-mint-strong": { fontWeight: "bold" },
  ".cm-mint-emphasis": { fontStyle: "italic" },
  ".cm-mint-strikethrough": { textDecoration: "line-through" },
  ".cm-mint-code": {
    fontFamily: "var(--mint-font-code, monospace)",
    backgroundColor: "var(--mint-code-bg, rgba(127, 127, 127, 0.15))",
    borderRadius: "3px",
  },
  ".cm-mint-link": {
    color: "var(--mint-link, #2f7d6d)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  ".cm-mint-superscript": { verticalAlign: "super", fontSize: "0.8em" },
  ".cm-mint-subscript": { verticalAlign: "sub", fontSize: "0.8em" },
  ".cm-mint-marker": { color: "var(--mint-marker, #8a9099)" },
});

/** The live preview engine. Renderers are registered separately with {@link previewRenderer}. */
export function livePreview(): Extension {
  return [inlinePreview, blockPreview, previewTheme];
}
