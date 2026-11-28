import { toString as paragraphText } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const parser = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm).use(remarkMath);

interface MarkdownTask {
  checked: boolean;
  label: string;
  location: { line: number; from: number; to: number; text: string };
}

/** Keep the original line alongside the label so navigation can detect a stale result. */
export function markdownTasks(source: string): MarkdownTask[] {
  if (!source.includes("[")) return [];
  const tasks: MarkdownTask[] = [];
  const lines = source.split(/\r\n|\n|\r/);
  visit(parser.parse(source), "listItem", (item) => {
    const paragraph = item.children[0];
    if (item.checked == null || paragraph?.type !== "paragraph" || !paragraph.position) return;
    const { line, column } = paragraph.position.start;
    const text = lines[line - 1] ?? "";
    // remark skips the leading BOM when reporting columns on the first line.
    const from = column - 1 + Number(line === 1 && source.startsWith("\uFEFF"));
    tasks.push({
      checked: item.checked,
      label: paragraphText(paragraph).replace(/\s+/g, " ").trim(),
      location: { line, text, from, to: text.trimEnd().length },
    });
  });
  return tasks;
}
