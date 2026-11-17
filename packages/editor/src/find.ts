import { SearchQuery } from "@codemirror/search";
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

/**
 * Find and replace within the current document.
 *
 * Matching runs on the Markdown source, never on rendered text, so a match
 * inside markers that live preview hides (e.g. the `**` of a bold span) is
 * still found. Moving to a match selects its exact source range; the
 * selection is what makes span reveal show the hidden markers around it.
 */

/** What to look for. Options default to off. */
export interface FindQuery {
  readonly search: string;
  /** Replacement text. With `regexp`, `$&`, `$1`…`$99` and `$$` expand as in `String.prototype.replace`. */
  readonly replace?: string;
  readonly caseSensitive?: boolean;
  /** Only match whole words. */
  readonly wholeWord?: boolean;
  /** Treat `search` as a JavaScript regular expression. */
  readonly regexp?: boolean;
}

export interface FindStatus {
  /** Number of matches in the document. */
  readonly total: number;
  /** 1-based index of the match that is currently selected, or 0 if the selection is not a match. */
  readonly current: number;
  /** False when the query is empty or an invalid regular expression. */
  readonly valid: boolean;
}

/** Find commands, merged into the editor's named commands. */
export interface FindCommands {
  /** Set (or with `null`, clear) the find query. Matches get highlighted; the selection does not move. */
  setFindQuery: [query: FindQuery | null];
  /** Select the next match after the selection, wrapping around the end. */
  findNext: [];
  /** Select the previous match before the selection, wrapping around the start. */
  findPrevious: [];
  /** Replace the selected match and select the next one; if no match is selected, just select the next. */
  replaceNext: [];
  /** Replace every match in one change, undone as a single step. */
  replaceAll: [];
}

const setQuery = StateEffect.define<SearchQuery | null>();

const queryField = StateField.define<SearchQuery | null>({
  create: () => null,
  update(query, tr) {
    for (const effect of tr.effects) if (effect.is(setQuery)) query = effect.value;
    return query;
  },
  provide: (field) =>
    EditorView.decorations.compute([field, "doc", "selection"], (state) =>
      matchDecorations(state, state.field(field)),
    ),
});

const matchMark = Decoration.mark({ class: "mint-find-match" });
const currentMark = Decoration.mark({ class: "mint-find-match mint-find-match-current" });

/** At most this many matches are highlighted, so a one-letter query on a huge file stays cheap. */
const MAX_HIGHLIGHTS = 5000;

function matchDecorations(state: EditorState, query: SearchQuery | null): DecorationSet {
  if (!query?.valid) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const { from: selFrom, to: selTo } = state.selection.main;
  let count = 0;
  for (const { from, to } of matches(state, query)) {
    if (from === to) continue;
    builder.add(from, to, from === selFrom && to === selTo ? currentMark : matchMark);
    if (++count >= MAX_HIGHLIGHTS) break;
  }
  return builder.finish();
}

// Created once: a theme per editor would add a new style module for every instance.
const findTheme = EditorView.baseTheme({
  ".mint-find-match": { backgroundColor: "var(--mint-find-match, #ffe58a80)" },
  ".mint-find-match-current": { backgroundColor: "var(--mint-find-current, #ffb84d)" },
});

export function findReplace(): Extension {
  return [queryField, findTheme];
}

function toSearchQuery(query: FindQuery): SearchQuery {
  return new SearchQuery({
    search: query.search,
    replace: query.replace ?? "",
    caseSensitive: query.caseSensitive ?? false,
    wholeWord: query.wholeWord ?? false,
    regexp: query.regexp ?? false,
    // What the user types is what is searched for: `\n` is two characters, not a line break.
    literal: true,
  });
}

interface Match {
  readonly from: number;
  readonly to: number;
  readonly groups: RegExpExecArray | null;
}

function* matches(state: EditorState, query: SearchQuery, from = 0, to = state.doc.length) {
  const cursor = query.getCursor(state, from, to) as Iterator<{
    from: number;
    to: number;
    match?: RegExpExecArray;
  }>;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    yield { from: next.value.from, to: next.value.to, groups: next.value.match ?? null } as Match;
  }
}

function allMatches(state: EditorState, query: SearchQuery): Match[] {
  return [...matches(state, query)].filter((m) => m.from < m.to);
}

function replacementFor(query: SearchQuery, match: Match): string {
  if (!query.regexp || !match.groups) return query.replace;
  const groups = match.groups;
  return query.replace.replace(/\$([$&]|\d\d?)/g, (whole, token: string) => {
    if (token === "$") return "$";
    if (token === "&") return groups[0];
    const n = Number(token);
    if (n > 0 && n < groups.length) return groups[n] ?? "";
    // "$12" with only one group means group 1 followed by "2".
    if (token.length === 2) {
      const first = Number(token[0]);
      if (first > 0 && first < groups.length) return (groups[first] ?? "") + token[1];
    }
    return whole;
  });
}

export function findStatus(state: EditorState): FindStatus {
  const query = state.field(queryField, false) ?? null;
  if (!query?.valid) return { total: 0, current: 0, valid: false };
  const { from, to } = state.selection.main;
  const found = allMatches(state, query);
  const index = found.findIndex((m) => m.from === from && m.to === to);
  return { total: found.length, current: index + 1, valid: true };
}

function select(view: EditorView, match: Match | undefined): boolean {
  if (!match) return false;
  view.dispatch({
    selection: EditorSelection.single(match.from, match.to),
    scrollIntoView: true,
    userEvent: "select.search",
  });
  return true;
}

export function findCommands(view: EditorView): {
  [C in keyof FindCommands]: (...args: FindCommands[C]) => boolean;
} {
  const current = () => {
    const query = view.state.field(queryField, false) ?? null;
    return query?.valid ? query : null;
  };
  const next = (query: SearchQuery, after: number) => {
    const found = allMatches(view.state, query);
    return found.find((m) => m.from >= after) ?? found[0];
  };

  return {
    setFindQuery(query) {
      view.dispatch({ effects: setQuery.of(query ? toSearchQuery(query) : null) });
      return true;
    },
    findNext() {
      const query = current();
      if (!query) return false;
      const { from, to } = view.state.selection.main;
      // Step past a selected match; otherwise a match may start right at the cursor.
      const found = allMatches(view.state, query);
      const match = found.find((m) =>
        from === to ? m.from >= from : m.from >= to && m.from > from,
      );
      return select(view, match ?? found[0]);
    },
    findPrevious() {
      const query = current();
      if (!query) return false;
      const { from } = view.state.selection.main;
      const found = allMatches(view.state, query);
      const match = found.findLast((m) => m.to <= from) ?? found.at(-1);
      return select(view, match);
    },
    replaceNext() {
      const query = current();
      if (!query) return false;
      const { from, to } = view.state.selection.main;
      const selected = allMatches(view.state, query).find((m) => m.from === from && m.to === to);
      if (!selected) return select(view, next(query, from));
      const insert = view.state.toText(replacementFor(query, selected));
      view.dispatch({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(from + insert.length),
        userEvent: "input.replace",
      });
      select(view, next(query, from + insert.length));
      return true;
    },
    replaceAll() {
      const query = current();
      if (!query) return false;
      const found = allMatches(view.state, query);
      if (found.length === 0) return false;
      const changes: ChangeSpec[] = found.map((m) => ({
        from: m.from,
        to: m.to,
        insert: view.state.toText(replacementFor(query, m)),
      }));
      view.dispatch({ changes, userEvent: "input.replace.all", scrollIntoView: true });
      return true;
    },
  };
}
