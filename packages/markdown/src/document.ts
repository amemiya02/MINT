import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Parser } from "@lezer/common";
import { highlightCode, tagHighlighter } from "@lezer/highlight";
import type { Element, ElementContent, Root, RootContent } from "hast";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { codeTokenCss, codeTokens } from "./code-tokens.ts";
import type { Dialect } from "./dialect.ts";
import { documentCss } from "./document-styles.ts";
import { renderHtml } from "./export.ts";

/**
 * The standalone HTML document a Markdown document exports to: one file with
 * everything inlined (theme, KaTeX stylesheet and fonts, highlighted code,
 * rendered diagrams, optionally images), so it opens offline and can be sent
 * as is. HTML export writes it to disk; PDF export prints it.
 */
export interface ExportOptions {
  readonly dialect: Dialect;
  /** The `<title>` of a document without headings; otherwise it is the text of the first one. */
  readonly title?: string;
  /**
   * The theme: a stylesheet setting MINT's theme variables (docs/themes.md),
   * typically the built-in themes followed by a user theme. Inlined as is,
   * after the document's own styles, so it may also override them.
   */
  readonly themeCss: string;
  /** Set as `data-appearance` on `<html>`, where themes key their light and dark values. */
  readonly appearance: "light" | "dark";
  /**
   * Render a Mermaid diagram's source to SVG; rejects on a syntax error.
   * Without it (or with the `mermaid` dialect switch off) diagrams stay code blocks.
   */
  readonly renderMermaid?: (source: string) => Promise<string>;
  /**
   * Load an image the document references (`src` exactly as written) to embed
   * it as a data URI. Resolving to `null` keeps the reference as written.
   * Without it no image is embedded.
   */
  readonly loadImage?: (src: string) => Promise<ExportImage | null>;
}

export interface ExportImage {
  readonly data: Uint8Array;
  /** Its media type, e.g. `image/png`. */
  readonly type: string;
}

/** Render Markdown to a standalone HTML document. */
export async function exportHtml(markdown: string, options: ExportOptions): Promise<string> {
  const tree = unified()
    .use(rehypeParse, { fragment: true })
    .parse(renderHtml(markdown, options.dialect));

  const work: Promise<void>[] = [];
  let math = false;
  visit(tree, "element", (node, index, parent) => {
    if (classes(node).includes("katex")) {
      math = true;
      return SKIP;
    }
    if (node.tagName === "pre" && parent && index !== undefined) {
      const code = node.children.find(
        (child): child is Element => child.type === "element" && child.tagName === "code",
      );
      if (code) work.push(codeBlock(node, code, options));
      return SKIP;
    }
    if (node.tagName === "img" && options.loadImage) {
      work.push(embedImage(node, options.loadImage));
    }
    return undefined;
  });
  await Promise.all(work);

  const katexCss = math ? (await import("./katex-assets.ts")).embeddedKatexCss() : "";
  const body = unified().use(rehypeStringify, { allowDangerousHtml: true }).stringify(tree);
  const title = firstHeading(tree) || (options.title ?? "");
  const styles = [documentCss, codeTokenCss(), katexCss, options.themeCss]
    .filter((css) => css !== "")
    .map((css) => `<style>\n${escapeStyle(css)}\n</style>`)
    .join("\n");
  return [
    "<!doctype html>",
    `<html data-appearance="${options.appearance}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="MINT">',
    `<title>${escapeText(title)}</title>`,
    styles,
    "</head>",
    "<body>",
    '<article class="mint-document">',
    body,
    "</article>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function classes(node: Element): string[] {
  const value = node.properties.className;
  return Array.isArray(value) ? value.map(String) : [];
}

function textOf(node: Root | RootContent | ElementContent): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(textOf).join("");
  return "";
}

function firstHeading(tree: Root): string {
  let title = "";
  visit(tree, "element", (node) => {
    if (!/^h[1-6]$/.test(node.tagName)) return undefined;
    title = textOf(node).trim();
    return false; // stop at the first heading
  });
  return title;
}

/** A fenced code block: a Mermaid diagram, or code highlighted like the editor highlights it. */
async function codeBlock(pre: Element, code: Element, options: ExportOptions): Promise<void> {
  const language =
    classes(code)
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length) ?? "";
  const source = textOf(code);
  if (language.toLowerCase() === "mermaid" && options.dialect.mermaid && options.renderMermaid) {
    await diagram(pre, source.replace(/\n$/, ""), options.renderMermaid);
    return;
  }
  if (language === "") return;
  pre.properties.dataLanguage = language;
  const description = LanguageDescription.matchLanguageName(languages, language, true);
  if (!description) return;
  let support: Awaited<ReturnType<LanguageDescription["load"]>>;
  try {
    support = await description.load();
  } catch {
    return; // a grammar that fails to load leaves the code plain
  }
  code.children = highlight(source, support.language.parser);
}

const highlighter = tagHighlighter(
  codeTokens.map(({ tag, className }) => ({ tag, class: className })),
);

function highlight(source: string, parser: Parser): ElementContent[] {
  const out: ElementContent[] = [];
  highlightCode(
    source,
    parser.parse(source),
    highlighter,
    (text, className) => {
      out.push(
        className
          ? {
              type: "element",
              tagName: "span",
              properties: { className: className.split(" ") },
              children: [{ type: "text", value: text }],
            }
          : { type: "text", value: text },
      );
    },
    () => out.push({ type: "text", value: "\n" }),
  );
  return out;
}

/** Replace a ` ```mermaid ` block with its rendered diagram, or with the syntax error. */
async function diagram(
  pre: Element,
  source: string,
  render: (source: string) => Promise<string>,
): Promise<void> {
  let figure: Element;
  try {
    const svg = await render(source);
    figure = {
      type: "element",
      tagName: "figure",
      properties: { className: ["mint-mermaid"] },
      children: [{ type: "raw", value: svg } as unknown as ElementContent],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    figure = {
      type: "element",
      tagName: "pre",
      properties: { className: ["mint-mermaid-error"] },
      children: [{ type: "text", value: `Mermaid: ${message}` }],
    };
  }
  // Turn the <pre> into the figure in place.
  Object.assign(pre, figure);
}

async function embedImage(
  img: Element,
  load: (src: string) => Promise<ExportImage | null>,
): Promise<void> {
  const src = img.properties.src;
  if (typeof src !== "string" || src === "" || /^data:/i.test(src)) return;
  let image: ExportImage | null;
  try {
    image = await load(src);
  } catch {
    image = null; // an unreadable image stays a reference
  }
  if (image) img.properties.src = `data:${image.type};base64,${toBase64(image.data)}`;
}

function toBase64(data: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A stylesheet cannot contain `</style`, which would end the element early. */
function escapeStyle(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}
