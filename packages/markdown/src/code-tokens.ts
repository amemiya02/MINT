import { type Tag, tags } from "@lezer/highlight";

/**
 * How the tokens of code in fenced code blocks look: one class and one style
 * per kind of token, colored from the theme variables. The editor core's
 * highlighting and the exported HTML are both built from this list, with the
 * same Lezer grammars, so code looks the same while editing and once exported.
 */
export interface CodeToken {
  readonly tag: Tag | readonly Tag[];
  /** The documented `cm-mint-code-*` class (docs/themes.md). */
  readonly className: string;
  /** CSS declarations, with camel-cased property names. */
  readonly style: Readonly<Record<string, string>>;
}

export const codeTokens: readonly CodeToken[] = [
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
    className: "cm-mint-code-keyword",
    style: { color: "var(--mint-accent, #2f7d6d)", fontWeight: "600" },
  },
  {
    tag: [tags.string, tags.regexp, tags.special(tags.string)],
    className: "cm-mint-code-string",
    style: { color: "var(--mint-link, #2f7d6d)" },
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    className: "cm-mint-code-number",
    style: { color: "var(--mint-accent, #2f7d6d)" },
  },
  {
    tag: [tags.comment, tags.docComment],
    className: "cm-mint-code-comment",
    style: { color: "var(--mint-muted, #6b717a)", fontStyle: "italic" },
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.typeName],
    className: "cm-mint-code-name",
    style: { color: "var(--mint-heading-fg, inherit)" },
  },
];

/** The token styles as a stylesheet. */
export function codeTokenCss(): string {
  return codeTokens
    .map(({ className, style }) => {
      const declarations = Object.entries(style)
        .map(
          ([property, value]) =>
            `${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value};`,
        )
        .join(" ");
      return `.${className} { ${declarations} }`;
    })
    .join("\n");
}
