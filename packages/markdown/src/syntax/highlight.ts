import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import { splice } from "micromark-util-chunked";
import { classifyCharacter } from "micromark-util-classify-character";
import { resolveAll } from "micromark-util-resolve-all";
import type {
  Construct,
  Event,
  Extension,
  Resolver,
  State,
  Token,
  TokenizeContext,
  Tokenizer,
} from "micromark-util-types";

/**
 * `==highlight==` (extended syntax), with the rules of GFM strikethrough:
 * a run of exactly two `=` opens when it is left-flanking and closes when it
 * is right-flanking, and the text between is ordinary inline Markdown. The
 * editor's Lezer parser (packages/editor/src/extended-syntax.ts) follows the
 * same rules; the shared conformance samples check that they agree.
 *
 * Adapted from micromark-extension-gfm-strikethrough (MIT, Titus Wormer).
 */
declare module "micromark-util-types" {
  interface TokenTypeMap {
    highlight: "highlight";
    highlightSequence: "highlightSequence";
    highlightSequenceTemporary: "highlightSequenceTemporary";
    highlightText: "highlightText";
  }
}

declare module "mdast" {
  /** `==text==`; rendered as `<mark>`. */
  interface Highlight extends Parent {
    type: "highlight";
    children: PhrasingContent[];
  }
  interface PhrasingContentMap {
    highlight: Highlight;
  }
  interface RootContentMap {
    highlight: Highlight;
  }
}

const equals = 61;

const resolveAllHighlight: Resolver = (events, context) => {
  let index = -1;
  while (++index < events.length) {
    const closer = events[index] as Event;
    if (closer[0] !== "enter" || closer[1].type !== "highlightSequenceTemporary") continue;
    if (!closer[1]._close) continue;
    let open = index;
    while (open--) {
      const opener = events[open] as Event;
      if (
        opener[0] !== "exit" ||
        opener[1].type !== "highlightSequenceTemporary" ||
        !opener[1]._open
      ) {
        continue;
      }
      closer[1].type = "highlightSequence";
      opener[1].type = "highlightSequence";
      const highlight: Token = {
        type: "highlight",
        start: { ...opener[1].start },
        end: { ...closer[1].end },
      };
      const text: Token = {
        type: "highlightText",
        start: { ...opener[1].end },
        end: { ...closer[1].start },
      };
      const next: Event[] = [
        ["enter", highlight, context],
        ["enter", opener[1], context],
        ["exit", opener[1], context],
        ["enter", text, context],
      ];
      const insideSpan = context.parser.constructs.insideSpan.null;
      if (insideSpan) {
        splice(
          next,
          next.length,
          0,
          resolveAll(insideSpan, events.slice(open + 1, index), context),
        );
      }
      splice(next, next.length, 0, [
        ["exit", text, context],
        ["enter", closer[1], context],
        ["exit", closer[1], context],
        ["exit", highlight, context],
      ]);
      splice(events, open - 1, index - open + 3, next);
      index = open + next.length - 2;
      break;
    }
  }
  for (const event of events) {
    if (event[1].type === "highlightSequenceTemporary") event[1].type = "data";
  }
  return events;
};

const tokenizeHighlight: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  const previous = this.previous;
  const events = this.events;
  let size = 0;

  const start: State = (code) => {
    // Only at the start of a run of `=` (an escaped `=` before it does not count).
    if (previous === equals && events[events.length - 1]?.[1].type !== "characterEscape") {
      return nok(code);
    }
    effects.enter("highlightSequenceTemporary");
    return more(code);
  };

  const more: State = (code) => {
    if (code === equals) {
      if (size > 1) return nok(code);
      effects.consume(code);
      size++;
      return more;
    }
    if (size < 2) return nok(code);
    const token = effects.exit("highlightSequenceTemporary");
    const before = classifyCharacter(previous);
    const after = classifyCharacter(code);
    token._open = !after || (after === 2 && Boolean(before));
    token._close = !before || (before === 2 && Boolean(after));
    return ok(code);
  };

  return start;
};

const construct: Construct = {
  name: "highlight",
  tokenize: tokenizeHighlight,
  resolveAll: resolveAllHighlight,
};

export const highlightSyntax: Extension = {
  text: { [equals]: construct },
  insideSpan: { null: [construct] },
};

export const highlightFromMarkdown: FromMarkdownExtension = {
  enter: {
    highlight(token) {
      this.enter({ type: "highlight", children: [], data: { hName: "mark" } }, token);
    },
  },
  exit: {
    highlight(token) {
      this.exit(token);
    },
  },
};
