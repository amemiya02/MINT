import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import { asciiPunctuation, markdownLineEndingOrSpace } from "micromark-util-character";
import type { Code, Extension, State, TokenizeContext, Tokenizer } from "micromark-util-types";

/**
 * `^superscript^` and `~subscript~` (extended syntax), Pandoc style:
 *
 * - A single marker opens, unless the character before or after it is the
 *   same marker (so `~~` stays strikethrough and `^^` is text).
 * - The text runs to the next marker and may not contain spaces or line
 *   breaks; a backslash escapes the ASCII punctuation character after it.
 *   The text is not parsed further.
 *
 * The editor's Lezer parser (packages/editor/src/extended-syntax.ts) follows
 * the same rules; the shared conformance samples check that they agree.
 */
declare module "micromark-util-types" {
  interface TokenTypeMap {
    superscript: "superscript";
    subscript: "subscript";
    scriptMarker: "scriptMarker";
    scriptText: "scriptText";
  }
}

declare module "mdast" {
  /** `^text^`; rendered as `<sup>`. */
  interface Superscript extends Parent {
    type: "superscript";
    children: PhrasingContent[];
  }
  /** `~text~`; rendered as `<sub>`. */
  interface Subscript extends Parent {
    type: "subscript";
    children: PhrasingContent[];
  }
  interface PhrasingContentMap {
    superscript: Superscript;
    subscript: Subscript;
  }
  interface RootContentMap {
    superscript: Superscript;
    subscript: Subscript;
  }
}

const backslash = 92;

function scriptSyntax(marker: number, type: "superscript" | "subscript"): Extension {
  const tokenize: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
    const previous = this.previous;

    const start: State = (code) => {
      if (code !== marker || previous === marker) return nok(code);
      effects.enter(type);
      effects.enter("scriptMarker");
      effects.consume(code);
      effects.exit("scriptMarker");
      return first;
    };

    const first: State = (code) => {
      if (code === marker || isEnd(code)) return nok(code);
      effects.enter("scriptText");
      return inside(code);
    };

    const inside: State = (code) => {
      if (isEnd(code)) return nok(code);
      if (code === marker) {
        effects.exit("scriptText");
        effects.enter("scriptMarker");
        effects.consume(code);
        effects.exit("scriptMarker");
        effects.exit(type);
        return ok;
      }
      effects.consume(code);
      return code === backslash ? escaped : inside;
    };

    const escaped: State = (code) => {
      if (isEnd(code)) return nok(code);
      if (asciiPunctuation(code)) {
        effects.consume(code);
        return inside;
      }
      return inside(code);
    };

    return start;
  };

  return { text: { [marker]: { name: type, tokenize } } };
}

const isEnd = (code: Code) => code === null || markdownLineEndingOrSpace(code);

/** The text of a script with its backslash escapes resolved. */
const resolveEscapes = (source: string) => source.replace(/\\([!-/:-@[-`{-~])/g, "$1");

function scriptFromMarkdown(type: "superscript" | "subscript"): FromMarkdownExtension {
  return {
    enter: {
      [type](token) {
        this.enter(
          { type, children: [], data: { hName: type === "superscript" ? "sup" : "sub" } },
          token,
        );
      },
      scriptText(token) {
        this.enter({ type: "text", value: resolveEscapes(this.sliceSerialize(token)) }, token);
      },
    },
    exit: {
      [type](token) {
        this.exit(token);
      },
      scriptText(token) {
        this.exit(token);
      },
    },
  };
}

export const superscriptSyntax = scriptSyntax(94, "superscript");
export const superscriptFromMarkdown = scriptFromMarkdown("superscript");
export const subscriptSyntax = scriptSyntax(126, "subscript");
export const subscriptFromMarkdown = scriptFromMarkdown("subscript");
