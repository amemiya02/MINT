/**
 * Styles of an exported document, written against MINT's theme variables
 * (docs/themes.md) so it looks like the document does in the editor, in the
 * chosen theme. Each variable has a fallback, so the document is readable
 * even with a theme that sets none.
 */
export const documentCss = `
html {
  background: var(--mint-bg, #fdfdfc);
  color: var(--mint-fg, #1f2328);
}
body {
  margin: 0;
  font-family: var(--mint-font-editor, ui-monospace, monospace);
  font-size: var(--mint-font-size, 15px);
  line-height: var(--mint-line-height, 1.7);
  overflow-wrap: break-word;
}
.mint-document {
  box-sizing: border-box;
  max-width: var(--mint-content-width, 740px);
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
}
.mint-document > :first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 {
  color: var(--mint-heading-fg, inherit);
  font-family: var(--mint-font-heading, inherit);
  font-weight: var(--mint-heading-weight, 650);
  line-height: 1.3;
  margin: 1.4em 0 0.6em;
}
h1 { font-size: var(--mint-heading-1-size, 1.75em); }
h2 { font-size: var(--mint-heading-2-size, 1.5em); }
h3 { font-size: var(--mint-heading-3-size, 1.3em); }
h4 { font-size: var(--mint-heading-4-size, 1.15em); }
h5 { font-size: var(--mint-heading-5-size, 1em); }
h6 { font-size: var(--mint-heading-6-size, 0.95em); }
p, ul, ol, blockquote, pre, table, figure { margin: 0 0 1em; }
strong { font-weight: bold; color: var(--mint-strong-fg, inherit); }
em { font-style: italic; color: var(--mint-emphasis-fg, inherit); }
a { color: var(--mint-link, #2f7d6d); }
::selection { background: var(--mint-selection, #cfe5df); }
code, pre, kbd, samp {
  font-family: var(--mint-font-code, ui-monospace, monospace);
  color: var(--mint-code-fg, inherit);
}
:not(pre) > code {
  background: var(--mint-code-bg, rgba(127, 127, 127, 0.1));
  border-radius: 3px;
  padding: 0.1em 0.3em;
}
pre {
  position: relative;
  background: var(--mint-code-bg, rgba(127, 127, 127, 0.1));
  padding: 0.6em 0.8em;
  overflow-x: auto;
  white-space: pre;
}
pre[data-language]::before {
  content: attr(data-language);
  float: right;
  font-size: 0.8em;
  color: var(--mint-marker, #8a9099);
}
blockquote {
  color: var(--mint-quote-fg, #5b616a);
  border-left: 3px solid var(--mint-border, #e3e5e8);
  padding-left: 1em;
  margin-left: 0;
}
hr { border: none; border-top: 1px solid var(--mint-border, #e3e5e8); margin: 1.5em 0; }
img { max-width: 100%; }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--mint-border, #e3e5e8); padding: 0.3em 0.7em; }
th { font-weight: 600; }
li.task-list-item { list-style: none; }
li.task-list-item input[type="checkbox"] { margin: 0 0.4em 0 -1.3em; accent-color: var(--mint-accent, #2f7d6d); }
section.footnotes { border-top: 1px solid var(--mint-border, #e3e5e8); font-size: 0.9em; margin-top: 2em; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
.katex-display { overflow-x: auto; overflow-y: hidden; }
.katex-error { color: var(--mint-error-fg, #a1260d); }
figure.mint-mermaid { display: flex; justify-content: center; margin-left: 0; margin-right: 0; }
figure.mint-mermaid svg { max-width: 100%; height: auto; }
pre.mint-mermaid-error {
  white-space: pre-wrap;
  color: var(--mint-error-fg, #a1260d);
  background: var(--mint-error-bg, #fdecea);
}
@page { margin: 16mm 14mm; }
@media print {
  /* Print the theme's colours (a dark theme's background too), not the printer's defaults. */
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .mint-document { max-width: none; padding: 0; }
  /* Keep code blocks, images, diagrams and display formulas whole on a page where they fit. */
  pre, blockquote, figure, img, svg, tr, .katex-display {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  /* Paper does not scroll: wrap long code lines and show wide content whole. */
  pre { white-space: pre-wrap; overflow: visible; }
  table { display: table; overflow: visible; }
  .katex-display { overflow: visible; }
  img, svg { max-width: 100%; }
}
`.trim();
