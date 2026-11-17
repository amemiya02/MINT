import { ParseContext } from "@codemirror/language";
import { afterEach, beforeEach, expect, vi } from "vitest";

// CodeMirror parses synchronously only within a small time budget (20ms when
// a state is created or a change is applied) and finishes in the background.
// On a loaded machine a cold parse can overrun it, leaving block and preview
// decorations missing when a test asserts right away. Tests have no deadline
// to keep, so let every time-budgeted parse run to completion; the parse
// itself, and production behaviour, are unchanged.
type Work = (until: number | (() => boolean), upto?: number) => boolean;
const parseContext = ParseContext.prototype as unknown as { work: Work };
const work = parseContext.work;
parseContext.work = function (this: ParseContext, until, upto) {
  return work.call(this, typeof until === "number" ? () => false : until, upto);
};

// jsdom has no layout. CodeMirror measures ranges when handling mouse input,
// so give ranges empty geometry instead of missing methods.
const emptyRects = (): DOMRectList =>
  Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

// CodeMirror reports crashing extensions (such as a renderer producing invalid
// decorations) with console.error and carries on; treat that as a failure.
let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(errors.map((args) => args.map(String).join(" "))).toEqual([]);
});
