import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { codeTokens } from "@mint/markdown";

/**
 * How the editor core looks. Every color, font and size comes from a MINT CSS
 * variable (with a fallback, so the core also looks right in a page that
 * defines none), and every styled piece of Markdown carries a documented
 * `cm-mint-*` class. Both are the theme contract; see docs/themes.md.
 */

const headings = [
  tags.heading1,
  tags.heading2,
  tags.heading3,
  tags.heading4,
  tags.heading5,
  tags.heading6,
];

/** Class names given to Markdown syntax, in both live preview and source mode. */
const markdownClasses = HighlightStyle.define([
  ...headings.map((tag, i) => ({ tag, class: `cm-mint-heading cm-mint-heading-${i + 1}` })),
  { tag: tags.quote, class: "cm-mint-quote" },
  { tag: tags.emphasis, class: "cm-mint-md-emphasis" },
  { tag: tags.strong, class: "cm-mint-md-strong" },
  { tag: tags.strikethrough, class: "cm-mint-md-strikethrough" },
  { tag: tags.link, class: "cm-mint-md-link" },
  { tag: tags.url, class: "cm-mint-md-url" },
  { tag: tags.monospace, class: "cm-mint-md-code" },
  { tag: tags.processingInstruction, class: "cm-mint-md-mark" },
  { tag: tags.contentSeparator, class: "cm-mint-md-rule" },
]);

/** Tokens of the code in fenced code blocks, styled as in exported documents. */
const codeClasses = HighlightStyle.define(
  codeTokens.map(({ tag, className }) => ({ tag, class: className })),
);

const headingSizes = ["1.75em", "1.5em", "1.3em", "1.15em", "1em", "0.95em"];

const markdownTheme = EditorView.baseTheme({
  ".cm-mint-heading": {
    color: "var(--mint-heading-fg, inherit)",
    fontFamily: "var(--mint-font-heading, inherit)",
    fontWeight: "var(--mint-heading-weight, 650)",
  },
  ...Object.fromEntries(
    headingSizes.map((size, i) => [
      `.cm-mint-heading-${i + 1}`,
      { fontSize: `var(--mint-heading-${i + 1}-size, ${size})` },
    ]),
  ),
  ".cm-mint-quote": { color: "var(--mint-quote-fg, #6b717a)" },
  ".cm-mint-md-emphasis": { fontStyle: "italic", color: "var(--mint-emphasis-fg, inherit)" },
  ".cm-mint-md-strong": { fontWeight: "bold", color: "var(--mint-strong-fg, inherit)" },
  ".cm-mint-md-strikethrough": { textDecoration: "line-through" },
  ".cm-mint-md-link": { color: "var(--mint-link, #2f7d6d)" },
  ".cm-mint-md-url": { color: "var(--mint-muted, #6b717a)" },
  ".cm-mint-md-code": {
    fontFamily: "var(--mint-font-code, monospace)",
    color: "var(--mint-code-fg, inherit)",
  },
  ...Object.fromEntries(codeTokens.map(({ className, style }) => [`.${className}`, style])),
  ".cm-mint-md-mark": { color: "var(--mint-marker, #8a9099)" },
  ".cm-mint-md-rule": { color: "var(--mint-marker, #8a9099)" },
});

// A full theme (not a base theme) so it outranks CodeMirror's own light/dark defaults.
const surfaceTheme = EditorView.theme({
  ".cm-content": { caretColor: "var(--mint-caret, currentColor)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--mint-caret, currentColor)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--mint-selection, #d7e9e4)" },
});

/** Theme classes and variable-driven styles for the editor. Created once and shared by every editor. */
const editorTheme: Extension = [
  syntaxHighlighting(markdownClasses),
  syntaxHighlighting(codeClasses),
  markdownTheme,
  surfaceTheme,
];

export function themeable(): Extension {
  return editorTheme;
}
