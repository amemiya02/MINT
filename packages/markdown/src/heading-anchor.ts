import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as headingText } from "mdast-util-to-string";
import { visit } from "unist-util-visit";

/** The base fragment used by Markdown heading links and the exported table of contents. */
function headingAnchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/**
 * GitHub-style heading anchors: lower case, punctuation dropped, spaces as
 * `-`; repeated anchors get `-1`, `-2`… appended.
 */
export function headingAnchors() {
  const occurrences = new Map<string, number>();
  return (text: string) => {
    const base = headingAnchor(text);
    let slug = base;
    while (occurrences.has(slug)) {
      const n = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, n);
      slug = `${base}-${n}`;
    }
    occurrences.set(slug, 0);
    return { base, id: slug };
  };
}

/** Unsuffixed repeated headings remain ambiguous. An explicit numbered anchor selects one occurrence. */
export function matchingHeadings<T extends { readonly text: string }>(
  headings: readonly T[],
  fragment: string,
): T[] {
  const next = headingAnchors();
  return headings.filter(({ text }) => {
    const { base, id } = next(text);
    return fragment === text || fragment === base || fragment === id;
  });
}

/** Heading text for resolving a fragment in Markdown that is not open in an editor. */
export function markdownHeadings(source: string) {
  const headings: { text: string; line: number }[] = [];
  visit(fromMarkdown(source), "heading", (node) => {
    headings.push({
      text: headingText(node).replace(/\s+/g, " ").trim(),
      line: node.position?.start.line ?? 1,
    });
  });
  return headings;
}
