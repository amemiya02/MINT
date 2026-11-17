import type { Element, ElementContent } from "hast";
import type { Heading, Nodes, Root } from "mdast";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import { toString as textOf } from "mdast-util-to-string";
import { markdownLineEnding, markdownSpace } from "micromark-util-character";
import type { Code, Extension, State, TokenizeContext, Tokenizer } from "micromark-util-types";
import type { Plugin } from "unified";

/**
 * `[TOC]` (extended syntax): a line holding only `[TOC]` (after up to three
 * spaces of indentation, before any trailing spaces) is a table of contents
 * of the document's headings. It starts a block of its own; within a
 * paragraph it is text. The editor's Lezer parser
 * (packages/editor/src/extended-syntax.ts) follows the same rule.
 */
declare module "micromark-util-types" {
  interface TokenTypeMap {
    toc: "toc";
  }
}

declare module "mdast" {
  /** A `[TOC]` line; rendered as a `<nav class="toc">` list of links to the headings. */
  interface Toc extends Node {
    type: "toc";
  }
  interface BlockContentMap {
    toc: Toc;
  }
  interface RootContentMap {
    toc: Toc;
  }
}

const marker = "[TOC]";

const tokenizeToc: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  // A `[TOC]` line never interrupts a paragraph.
  if (this.interrupt) return nok;
  let index = 0;

  const inside: State = (code) => {
    if (index < marker.length) {
      if (code !== marker.charCodeAt(index)) return nok(code);
      effects.consume(code);
      index++;
      return inside;
    }
    return after(code);
  };

  const after: State = (code: Code) => {
    if (markdownSpace(code)) {
      effects.consume(code);
      return after;
    }
    if (code !== null && !markdownLineEnding(code)) return nok(code);
    effects.exit("toc");
    return ok(code);
  };

  return (code) => {
    effects.enter("toc");
    return inside(code);
  };
};

export const tocSyntax: Extension = {
  flow: { [marker.charCodeAt(0)]: { name: "toc", tokenize: tokenizeToc } },
};

export const tocFromMarkdown: FromMarkdownExtension = {
  enter: {
    toc(token) {
      this.enter({ type: "toc" }, token);
    },
  },
  exit: {
    toc(token) {
      this.exit(token);
    },
  },
};

/**
 * GitHub-style heading anchors: lower case, punctuation dropped, spaces as
 * `-`; repeated anchors get `-1`, `-2`… appended.
 */
function slugger() {
  const occurrences = new Map<string, number>();
  return (text: string) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    let slug = base;
    while (occurrences.has(slug)) {
      const n = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, n);
      slug = `${base}-${n}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}

const element = (tagName: string, children: ElementContent[], properties = {}): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});

/** Nested `<ul>` lists of links following the heading levels. */
function tocList(headings: readonly { level: number; text: string; id: string }[]): Element[] {
  const root = element("ul", []);
  const stack: { level: number; list: Element }[] = [{ level: 0, list: root }];
  for (const heading of headings) {
    while (
      stack.length > 1 &&
      (stack[stack.length - 1] as { level: number }).level >= heading.level
    ) {
      stack.pop();
    }
    const parent = stack[stack.length - 1] as { list: Element };
    const item = element("li", [
      element("a", [{ type: "text", value: heading.text }], { href: `#${heading.id}` }),
    ]);
    parent.list.children.push(item);
    const sublist = element("ul", []);
    item.children.push(sublist);
    stack.push({ level: heading.level, list: sublist });
  }
  // Drop the lists that stayed empty.
  const prune = (node: Element) => {
    node.children = node.children.filter(
      (child) => child.type !== "element" || child.tagName !== "ul" || child.children.length > 0,
    );
    for (const child of node.children) if (child.type === "element") prune(child);
  };
  prune(root);
  return root.children.length > 0 ? [root] : [];
}

/** Gives every heading an anchor and renders `toc` nodes, when the document has any. */
const renderToc: Plugin<[], Root> = () => (tree) => {
  const tocs: Nodes[] = [];
  const headings: Heading[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "toc") tocs.push(node);
    else if (node.type === "heading") headings.push(node);
    else if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  if (tocs.length === 0) return;

  const slug = slugger();
  const entries = headings.map((heading) => {
    const text = textOf(heading).replace(/\s+/g, " ").trim();
    const id = slug(text);
    heading.data = {
      ...heading.data,
      hProperties: { ...heading.data?.hProperties, id },
    };
    return { level: heading.depth, text, id };
  });
  const children = tocList(entries);
  for (const toc of tocs) {
    toc.data = { hName: "nav", hProperties: { className: ["toc"] }, hChildren: children };
  }
};

export const tocPlugins = [renderToc];
