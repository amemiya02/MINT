import { renderHtml } from "@mint/markdown";
import type { ExportSource } from "./export-formats.ts";

const escapes: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  "%": "\\%",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

function escapeText(text: string) {
  return text.replace(/[\\{}$&#%_~^]/g, (char) => escapes[char] ?? char);
}

const headings = [
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
  "subparagraph",
];

function renderNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? "");
  if (!(node instanceof Element)) return "";

  // KaTeX retains the author's TeX alongside the rendered equation.
  if (node.classList.contains("katex-display") || node.classList.contains("katex")) {
    const formula = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (formula)
      return node.classList.contains("katex-display") ? `\\[\n${formula}\n\\]\n` : `$${formula}$`;
  }
  const body = [...node.childNodes].map(renderNode).join("");
  const tag = node.localName;
  if (/^h[1-6]$/.test(tag)) return `\\${headings[Number(tag[1]) - 1]}{${body}}\n`;
  switch (tag) {
    case "p":
      return `${body}\n\n`;
    case "ul":
    case "ol": {
      const env = tag === "ul" ? "itemize" : "enumerate";
      return `\n\\begin{${env}}\n${body.trim()}\n\\end{${env}}\n`;
    }
    case "li":
      return `\\item ${body.trim()}`;
    case "em":
      return `\\emph{${body}}`;
    case "strong":
      return `\\textbf{${body}}`;
    case "code":
      return `\\texttt{${body}}`;
    case "pre":
      return `\n\\begin{alltt}\n${escapeText(node.textContent ?? "").trimEnd()}\n\\end{alltt}\n`;
    case "blockquote":
      return `\n\\begin{quote}\n${body}\n\\end{quote}\n`;
    case "br":
      return "\\\\\n";
    case "hr":
      return "\n\\noindent\\rule{\\linewidth}{0.4pt}\n";
    case "img":
      return escapeText(node.getAttribute("alt") ?? "");
    default:
      return body;
  }
}

export function encodeLatex({ text, dialect }: ExportSource): string {
  const fragment = document.createElement("template");
  fragment.innerHTML = renderHtml(text, dialect);
  const body = [...fragment.content.childNodes].map(renderNode).join("").trim();
  const hasHan = /\p{Script=Han}/u.test(body);
  return `\\documentclass{article}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb,alltt}${hasHan ? "\n\\usepackage{CJKutf8}" : ""}
\\begin{document}${hasHan ? "\n\\begin{CJK*}{UTF8}{gbsn}" : ""}
${body}${hasHan ? "\n\\end{CJK*}" : ""}
\\end{document}
`;
}
