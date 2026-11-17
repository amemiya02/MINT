import { afterEach, beforeEach, expect, vi } from "vitest";

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
