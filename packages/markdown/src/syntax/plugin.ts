import type { Root } from "mdast";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Extension as MicromarkExtension } from "micromark-util-types";
import type { Plugin } from "unified";

/** A remark plugin that teaches the parser one syntax: a micromark extension and its mdast mapping. */
export function syntaxPlugin(
  micromark: MicromarkExtension,
  fromMarkdown: FromMarkdownExtension,
): Plugin<[], Root> {
  return function () {
    const data = this.data();
    data.micromarkExtensions ??= [];
    data.micromarkExtensions.push(micromark);
    data.fromMarkdownExtensions ??= [];
    data.fromMarkdownExtensions.push(fromMarkdown);
  };
}
