import type { MarkdownConfig } from "@lezer/markdown";

/** Existing folder references: [[document#section]] or [[document#section|label]]. */
export const wikilinkSyntax: MarkdownConfig = {
  defineNodes: ["Wikilink", "WikilinkTarget", "WikilinkAlias"],
  parseInline: [
    {
      name: "Wikilink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 || cx.char(pos + 1) !== 91 || cx.hasOpenLink) return -1;
        let end = pos + 2;
        let bar = -1;
        while (end < cx.end) {
          const ch = cx.char(end);
          if (ch === 93) break;
          if (ch === 91 || ch === 10) return -1;
          if (ch === 124 && bar < 0) bar = end;
          end++;
        }
        if (cx.char(end) !== 93 || cx.char(end + 1) !== 93) return -1;
        const targetEnd = bar < 0 ? end : bar;
        const target = cx.slice(pos + 2, targetEnd).trim();
        if (!target || target === "#") return -1;
        const children = [cx.elt("WikilinkTarget", pos + 2, targetEnd)];
        if (bar >= 0 && bar + 1 < end) children.push(cx.elt("WikilinkAlias", bar + 1, end));
        return cx.addElement(cx.elt("Wikilink", pos, end + 2, children));
      },
    },
  ],
};
