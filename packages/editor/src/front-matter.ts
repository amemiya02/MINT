import type { Input } from "@lezer/common";
import type { BlockContext, Element, MarkdownConfig } from "@lezer/markdown";

/** A front matter fence: exactly `---`, optionally followed by spaces or tabs. */
const fence = /^---[ \t]*$/;
/** The first closing fence after the opening line. */
const closingFence = /\n(---[ \t]*)(?:\n|$)/;

/**
 * The parse input. `BlockContext.input` is internal to @lezer/markdown, but a
 * block parser can only look one line ahead through the public API, and front
 * matter needs to know whether a closing fence exists before claiming the
 * opening line (otherwise `---` is a horizontal rule).
 */
function inputOf(cx: BlockContext): Input | undefined {
  const input = (cx as unknown as { input?: Input }).input;
  return typeof input?.read === "function" ? input : undefined;
}

/**
 * YAML front matter: a block delimited by `---` lines, only at the very start
 * of the document, and only when a closing fence follows. These are the rules
 * remark-frontmatter applies on export, so editing and exporting agree on what
 * is front matter. Parsed as `FrontMatter`, whose fences are `FrontMatterMark`.
 */
export const FrontMatter: MarkdownConfig = {
  defineNodes: [{ name: "FrontMatter", block: true }, { name: "FrontMatterMark" }],
  parseBlock: [
    {
      name: "FrontMatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0 || cx.depth !== 1 || !fence.test(line.text)) return false;
        const input = inputOf(cx);
        if (!input) return false;
        const match = closingFence.exec(input.read(0, input.length));
        if (!match) return false;
        const closeFrom = match.index + 1;
        const marks: Element[] = [cx.elt("FrontMatterMark", 0, 3)];
        while (cx.nextLine()) {
          if (cx.lineStart === closeFrom) {
            marks.push(cx.elt("FrontMatterMark", closeFrom, closeFrom + 3));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("FrontMatter", 0, cx.prevLineEnd(), marks));
        return true;
      },
    },
  ],
};
