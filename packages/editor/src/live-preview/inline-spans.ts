import { Decoration } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { PreviewContext, PreviewRenderer } from "./preview.ts";

/** Class on the visible text of a link; Mod-click on it opens the link. */
export const linkClass = "cm-mint-link";

const marker = Decoration.mark({ class: "cm-mint-marker" });
const link = Decoration.mark({ class: linkClass });

/** Delimited spans: the node is styled, its marker children are hidden unless revealed. */
const delimited: Record<string, { readonly style: Decoration; readonly mark: string }> = {
  StrongEmphasis: { style: Decoration.mark({ class: "cm-mint-strong" }), mark: "EmphasisMark" },
  Emphasis: { style: Decoration.mark({ class: "cm-mint-emphasis" }), mark: "EmphasisMark" },
  Strikethrough: {
    style: Decoration.mark({ class: "cm-mint-strikethrough" }),
    mark: "StrikethroughMark",
  },
  InlineCode: { style: Decoration.mark({ class: "cm-mint-code" }), mark: "CodeMark" },
  Superscript: {
    style: Decoration.mark({ class: "cm-mint-superscript" }),
    mark: "SuperscriptMark",
  },
  Subscript: { style: Decoration.mark({ class: "cm-mint-subscript" }), mark: "SubscriptMark" },
  Highlight: { style: Decoration.mark({ class: "cm-mint-highlight" }), mark: "HighlightMark" },
};

/** Show or hide a marker depending on whether its span is revealed. */
function markerRange(cx: PreviewContext, revealed: boolean, from: number, to: number) {
  if (to <= from) return;
  if (revealed) cx.add(from, to, marker);
  else cx.hide(from, to);
}

function renderDelimited(node: SyntaxNode, cx: PreviewContext) {
  const spec = delimited[node.name];
  if (!spec) return;
  cx.add(node.from, node.to, spec.style);
  const revealed = cx.touchesSelection(node.from, node.to);
  for (const mark of node.getChildren(spec.mark)) markerRange(cx, revealed, mark.from, mark.to);
}

/** `[text](url "title")`, `[text][ref]`, `[ref]`: everything except the text is a marker. */
function renderLink(node: SyntaxNode, cx: PreviewContext) {
  const marks = node.getChildren("LinkMark");
  const open = marks[0];
  const close = marks[1];
  if (!open || !close || open.from !== node.from) return;
  cx.add(open.to, close.from, link);
  const revealed = cx.touchesSelection(node.from, node.to);
  markerRange(cx, revealed, node.from, open.to);
  markerRange(cx, revealed, close.from, node.to);
}

/** Show the link label, revealing the surrounding source while editing the span. */
function renderLabel(node: SyntaxNode, cx: PreviewContext) {
  const label =
    node.getChild("URL") ?? node.getChild("WikilinkAlias") ?? node.getChild("WikilinkTarget");
  if (!label) return;
  cx.add(label.from, label.to, link);
  const revealed = cx.touchesSelection(node.from, node.to);
  markerRange(cx, revealed, node.from, label.from);
  markerRange(cx, revealed, label.to, node.to);
}

/** Nodes whose `URL` child is part of their own syntax rather than a bare URL. */
export const urlOwners: ReadonlySet<string> = new Set([
  "Link",
  "Autolink",
  "Image",
  "LinkReference",
]);

/** A bare URL (GFM autolink literal) has no markers; it is only styled as a link. */
function renderBareUrl(node: SyntaxNode, cx: PreviewContext) {
  if (!urlOwners.has(node.parent?.name ?? "")) cx.add(node.from, node.to, link);
}

/** Inline spans: emphasis, strong, strikethrough, inline code, links (and enabled extended spans). */
export const inlineSpans: PreviewRenderer = {
  nodes: [...Object.keys(delimited), "Wikilink", "Link", "Autolink", "URL"],
  render(node, cx) {
    if (node.name === "Link") renderLink(node, cx);
    else if (node.name === "Wikilink" || node.name === "Autolink") renderLabel(node, cx);
    else if (node.name === "URL") renderBareUrl(node, cx);
    else renderDelimited(node, cx);
    return undefined;
  },
};
