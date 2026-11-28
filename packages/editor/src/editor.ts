import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  redo,
  undo,
} from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { selectNextOccurrence } from "@codemirror/search";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Text,
  Transaction,
} from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  EditorView,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { defaultDialect, renderHtml } from "@mint/markdown";
import {
  type Annotation,
  type AnnotationTarget,
  annotationCellAt,
  cellTarget,
  markdownTarget,
  textTarget,
} from "./annotations.ts";
import { type EditorDialect, markdownSupport } from "./dialect.ts";
import {
  fileText,
  fromFileOffset,
  parseFileText,
  replaceFileText,
  sharedFileEffects,
  toFileOffset,
} from "./file-text.ts";
import {
  type FindCommands,
  type FindStatus,
  findCommands,
  findReplace,
  findStatus,
} from "./find.ts";
import { focusMode } from "./focus-mode.ts";
import { type FormattingCommands, formattingCommands } from "./formatting.ts";
import { type ImageFile, imageFileInsertion } from "./image-files.ts";
import { inlineCompletion, type RequestInlineCompletion } from "./inline-completion.ts";
import { type DocumentLink, type LinkTarget, linkAt, linkOpening } from "./links.ts";
import { codeBlocks, setCodeBlockLanguage } from "./live-preview/code-blocks.ts";
import { type CodeBlockRenderer, fencedRenderers } from "./live-preview/fenced-renderers.ts";
import { footnotes } from "./live-preview/footnotes.ts";
import { frontMatterPreview } from "./live-preview/front-matter.ts";
import { headings } from "./live-preview/headings.ts";
import { htmlBlockPreview } from "./live-preview/html-blocks.ts";
import { imagePreview, imageUrlResolver } from "./live-preview/images.ts";
import { inlineSpans } from "./live-preview/inline-spans.ts";
import { lists } from "./live-preview/lists.ts";
import { mathPreview } from "./live-preview/math.ts";
import { mermaidDiagrams } from "./live-preview/mermaid.ts";
import { livePreview, previewRenderer } from "./live-preview/preview.ts";
import { quotesAndRules } from "./live-preview/quotes-and-rules.ts";
import { tableOfContents } from "./live-preview/toc.ts";
import { markupContinuation } from "./markup-continuation.ts";
import { type OutlineHeading, outline, sameOutline } from "./outline.ts";
import { editorPreferences } from "./preferences.ts";
import { type ProsePassage, prosePassageAtCursor } from "./prose-passage.ts";
import { pasteText, richPaste } from "./rich-paste.ts";
import type { SharedDocument } from "./shared-document.ts";
import { type TableCommands, tableCommands } from "./table/commands.ts";
import {
  focusedTableCell,
  focusTableCell,
  runInFocusedTable,
  tableRenderer,
  tableTheme,
} from "./table/table-widget.ts";
import { themeable } from "./theme.ts";
import { centerCursor, typewriterMode } from "./typewriter-mode.ts";
import { countWords, type WordCount } from "./word-count.ts";

/**
 * Capabilities the editor core needs from whatever hosts it (desktop shell,
 * a web page, tests). The core never talks to a platform directly; future
 * capabilities are added here as optional members.
 */
export interface HostAdapter {
  /** Open a link the user ⌘-clicked (Ctrl-clicked off macOS). Without it, links do nothing. */
  openLink?(link: LinkTarget): void;
  /** Preview a local document without navigating away from this view. */
  previewLink?(link: DocumentLink): void;
  /** Copy plain text. Without it, the editor uses the browser clipboard. */
  writeClipboardText?(text: string): Promise<void>;
  /**
   * Turn the path of a local image, as written in the document (relative to
   * it, or absolute; angle brackets removed and percent-decoded), into a URL
   * the page can load, or `null` to show a placeholder. Images with a URL
   * scheme (`https:`, `data:`...) are loaded directly. Without it, paths are
   * used as URLs.
   */
  resolveImageUrl?(path: string): string | null;
  /**
   * Store an image file the user pasted or dropped (in the asset folder) and
   * resolve to its path relative to the document, `/`-separated; the editor
   * inserts a reference to it. Rejecting skips the file. Without it, pasting
   * and dropping image files is left to the default behaviour.
   */
  saveImage?(file: ImageFile): Promise<string>;
}

/**
 * `livePreview` renders the source in place (the default); `source` shows the
 * raw Markdown. Both edit the same text.
 */
export type EditorMode = "livePreview" | "source";

/** Display settings of the editor; none of them changes the text. */
export interface EditorSettings {
  /** Focus mode: only the paragraph with the cursor stays in full contrast, the rest is dimmed. */
  readonly focusMode: boolean;
  /** Typewriter mode: the line with the cursor stays at the vertical middle of the editor. */
  readonly typewriterMode: boolean;
  /** Vim key bindings: normal, insert and visual modes, and `:` commands. */
  readonly vim: boolean;
  /** The system spellchecker underlines misspelled words in the text (not in code, math or URLs). */
  readonly spellcheck: boolean;
}

const defaultSettings: EditorSettings = {
  focusMode: false,
  typewriterMode: false,
  vim: false,
  spellcheck: false,
};

export interface EditorOptions {
  /** Element the editor mounts into. */
  readonly parent: HTMLElement;
  readonly document?: SharedDocument;
  /** Full file text, exactly as decoded from disk (a leading U+FEFF BOM and any line endings are kept). */
  readonly text: string;
  readonly dialect?: EditorDialect;
  readonly host?: HostAdapter;
  /** Initial mode; defaults to `livePreview`. */
  readonly mode?: EditorMode;
  /**
   * Translations of the editor's own UI copy, keyed by the English text
   * (see `tablePhrases` and `codeBlockPhrases`). Untranslated text stays English.
   */
  readonly phrases?: Readonly<Record<string, string>>;
  /** Initial settings; each one left out is off. */
  readonly settings?: Partial<EditorSettings>;
}

/** A selection range in {@link MintEditor.getText} offsets (UTF-16 code units). */
export interface TextSelection {
  readonly anchor: number;
  readonly head: number;
}

export interface TextRange {
  readonly from: number;
  readonly to: number;
}

/** Named commands and their arguments. */
export interface EditorCommands extends FindCommands, FormattingCommands, TableCommands {
  undo: [];
  redo: [];
  /** Replace the selection with text, as if typed. Line breaks take the document's line ending. */
  insertText: [text: string];
  /**
   * Paste text exactly as given, never read as rich text (the host reads it
   * from the clipboard). One undo step; line breaks take the document's line ending.
   */
  pastePlainText: [text: string];
  /** Switch between live preview and source mode. Text and selection are unchanged. */
  toggleSourceMode: [];
  /** Preview the local document linked at the main selection. */
  previewLink: [];
  /** Set the language of the fenced code block at the cursor; only its info string changes. */
  setCodeBlockLanguage: [language: string];
  /**
   * Add a selection at the next occurrence of the main selection's text (after
   * selecting the word at a bare cursor first), for editing several places at once.
   */
  selectNextOccurrence: [];
}
export type EditorCommand = keyof EditorCommands;

export type EditorEvent =
  | { readonly type: "change"; readonly remote?: boolean; readonly fromHistory?: boolean }
  | { readonly type: "selection" }
  /** An input method finished composing, even if its final text was already visible. */
  | { readonly type: "compositionEnd" }
  | { readonly type: "mode" }
  /** The headings returned by {@link MintEditor.getOutline} changed. */
  | { readonly type: "outline" }
  /** The editor scrolled; {@link MintEditor.getVisibleRange} may have changed. */
  | { readonly type: "scroll" };

export interface MintEditor {
  /** The full file text, ready to be written to disk byte for byte. */
  getText(): string;
  /**
   * Replace the whole text with new file text, e.g. the document reloaded from
   * disk. The selection stays next to the text around it; undo restores the old text.
   */
  replaceText(text: string): void;
  /** Replace one range in its own undo step, preserving the surrounding file text. */
  replaceRange(range: TextRange, text: string): void;
  /** Capture a bounded passage of ordinary prose at the cursor for proofreading. */
  getProofreadingPassage(): ProsePassage | null;
  /** The main selection range. */
  getSelection(): TextSelection;
  /** Capture the selected manuscript content for a new annotation. */
  getAnnotationTarget(): AnnotationTarget | null;
  /** Scroll to and focus an existing annotation target. */
  revealAnnotation(annotation: Annotation): void;
  /** Every selection range (several when there are several cursors), in document order. */
  getSelections(): TextSelection[];
  /** Follow a range through edits, including edits from a second view. Boundary insertions stay outside it. */
  trackRange(range: TextRange): { current(): TextRange; release(): void };
  /** Put a cursor or selection at each range; there must be at least one. The last range is the main one. */
  setSelections(ranges: readonly { readonly anchor: number; readonly head?: number }[]): void;
  /** Replace the host-provided fenced block previews in this view. */
  setCodeBlockRenderers(renderers: readonly CodeBlockRenderer[]): void;
  getMode(): EditorMode;
  getSettings(): EditorSettings;
  /** Change some settings; the others keep their value. Takes effect at once. */
  updateSettings(settings: Partial<EditorSettings>): void;
  /** Use this view for inline writing suggestions, or clear the feature and any pending suggestion. */
  setInlineCompletion(request: RequestInlineCompletion | null): void;
  /** The outline: every heading in document order, with its level, text and position. */
  getOutline(): readonly OutlineHeading[];
  /** Words, characters and reading time of the document as rendered. Counts the whole text on every call. */
  getWordCount(): WordCount;
  /**
   * Select a range; with `scrollIntoView`, also scroll it into view (e.g. when
   * jumping to a search result). `"start"` scrolls its line to the top of the
   * editor (e.g. when jumping to a heading of the outline).
   */
  setSelection(selection: {
    anchor: number;
    head?: number;
    scrollIntoView?: boolean | "start";
  }): void;
  /**
   * The text on screen: from the start of the first line visible at the top of
   * the editor to the end of the last one visible at the bottom, in `getText()` offsets.
   */
  getVisibleRange(): { readonly from: number; readonly to: number };
  /** Capture the current scroll anchor and pixel offset for restoration after a modal view. */
  captureScrollPosition(): () => void;
  /** Matches of the find query set with the `setFindQuery` command. */
  getFindStatus(): FindStatus;
  /**
   * Parse and render with another dialect from now on (e.g. an extended
   * syntax switched on in the settings). Text and selection are unchanged.
   */
  setDialect(dialect: EditorDialect): void;
  /** Run a named command. Returns whether it did anything. */
  execute<C extends EditorCommand>(command: C, ...args: EditorCommands[C]): boolean;
  /** Listen for editor events. Returns an unsubscribe function. */
  subscribe(listener: (event: EditorEvent) => void): () => void;
  focus(): void;
  destroy(): void;
}

/**
 * Keys of CodeMirror's default keymap that MINT's default shortcuts take over
 * (they belong to the host's command registry): Mod-/ toggles source mode rather
 * than comments, Mod-i is italic rather than "select parent syntax", and
 * Shift-Mod-k inserts a code block rather than deleting the line.
 */
const hostKeys = new Set(["Mod-/", "Mod-i", "Shift-Mod-k"]);

/** Everything that depends on the dialect: the parser and the renderers of optional syntax. */
function dialectExtensions(dialect: EditorDialect): Extension {
  return [
    markdownSupport(dialect),
    richPaste(dialect),
    // Table cells are rendered like the export renders them.
    previewRenderer.of(tableRenderer((markdown) => renderHtml(markdown, dialect))),
    // Raw HTML blocks go through the same sanitising rendering as table cells.
    htmlBlockPreview((markdown) => renderHtml(markdown, dialect)),
    // Mermaid takes over its fences from codeBlocks (it matches only ```mermaid; the rest stay code blocks).
    dialect.mermaid ? mermaidDiagrams() : [],
  ];
}

export function createEditor(options: EditorOptions): MintEditor {
  const listeners = new Set<(event: EditorEvent) => void>();
  const trackedRanges = new Set<{ from: number; to: number }>();
  const parsed = options.document?.currentDocument() ?? parseFileText(options.text);
  const host = options.host ?? {};
  const fences = new Compartment();
  const preview = new Compartment();
  const syntax = new Compartment();
  const completion = new Compartment();
  let mode: EditorMode = options.mode ?? "livePreview";
  let lastOutline: readonly OutlineHeading[] = [];
  let settings: EditorSettings = { ...defaultSettings, ...options.settings };
  const focus = new Compartment();
  const typewriter = new Compartment();
  const focusExtension = () => (settings.focusMode ? focusMode() : []);
  const typewriterExtension = () => (settings.typewriterMode ? typewriterMode() : []);
  const preferences = editorPreferences(settings);
  const modeExtension = () => (mode === "livePreview" ? livePreview() : []);

  const view = new EditorView({
    parent: options.parent,
    dispatchTransactions: options.document?.dispatch.bind(options.document),
    state: EditorState.create({
      doc: parsed.doc,
      extensions: [
        parsed.extension,
        options.phrases ? EditorState.phrases.of(options.phrases) : [],
        completion.of([]),
        preferences.extension,
        history(),
        options.document?.initialHistory() ?? [],
        // Several cursors: typed text goes to all of them. Alt-drag selects a rectangle.
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        findReplace(),
        keymap.of([
          ...defaultKeymap.filter((b) => !b.key || !hostKeys.has(b.key)),
          ...historyKeymap,
        ]),
        fences.of([]),
        syntax.of(dialectExtensions(options.dialect ?? defaultDialect)),
        markupContinuation,
        themeable(),
        previewRenderer.of(inlineSpans),
        tableTheme,
        mathPreview(),
        headings,
        lists,
        quotesAndRules,
        footnotes,
        tableOfContents,
        codeBlocks(host.writeClipboardText?.bind(host)),
        imagePreview(),
        host.resolveImageUrl
          ? imageUrlResolver.of((path) => host.resolveImageUrl?.(path) ?? null)
          : [],
        host.saveImage ? imageFileInsertion(host.saveImage.bind(host)) : [],
        frontMatterPreview,
        preview.of(modeExtension()),
        focus.of(focusExtension()),
        typewriter.of(typewriterExtension()),
        linkOpening(host.openLink, host.previewLink),
        EditorView.lineWrapping,
        EditorView.domEventObservers({
          scroll: () => emit({ type: "scroll" }),
          compositionend: () => emit({ type: "compositionEnd" }),
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            for (const range of trackedRanges) {
              range.from = update.changes.mapPos(range.from, 1);
              range.to = Math.max(range.from, update.changes.mapPos(range.to, -1));
            }
          }
          if (update.docChanged || update.transactions.some((t) => sharedFileEffects(t).length > 0))
            emit(
              update.transactions.some((tr) => tr.annotation(Transaction.remote))
                ? { type: "change", remote: true }
                : {
                    type: "change",
                    fromHistory: update.transactions.some(
                      (tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"),
                    ),
                  },
            );
          if (update.selectionSet) emit({ type: "selection" });
          if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
            const next = outline(update.state, false);
            if (!sameOutline(next, lastOutline)) {
              lastOutline = next;
              emit({ type: "outline" });
            }
          }
        }),
      ],
    }),
  });

  options.document?.attach(view);
  lastOutline = outline(view.state, false);
  if (settings.typewriterMode) view.dispatch({ effects: centerCursor(view.state) });

  function emit(event: EditorEvent) {
    for (const listener of listeners) listener(event);
  }

  const commands: { [C in EditorCommand]: (...args: EditorCommands[C]) => boolean } = {
    ...findCommands(view),
    ...tableCommands(view, runInFocusedTable, focusTableCell),
    ...formattingCommands(view),
    undo: () => undo(view),
    redo: () => redo(view),
    insertText: (text) => {
      view.dispatch(view.state.replaceSelection(text), {
        userEvent: "input.type",
        scrollIntoView: true,
      });
      return true;
    },
    pastePlainText: (text) => {
      pasteText(view, text);
      return true;
    },
    setCodeBlockLanguage: (language) => setCodeBlockLanguage(view, language),
    selectNextOccurrence: () => selectNextOccurrence(view),
    previewLink: () => {
      const link = linkAt(view.state, view.state.selection.main.head);
      if (link?.kind !== "document" || !host.previewLink) return false;
      host.previewLink(link);
      return true;
    },
    toggleSourceMode: () => {
      mode = mode === "livePreview" ? "source" : "livePreview";
      view.dispatch({ effects: preview.reconfigure(modeExtension()) });
      emit({ type: "mode" });
      return true;
    },
  };

  return {
    getText: () => fileText(view.state),
    replaceText(text) {
      view.dispatch(replaceFileText(view.state, text));
    },
    replaceRange(range, text) {
      const state = view.state;
      const from = fromFileOffset(state, range.from);
      const to = fromFileOffset(state, range.to);
      const insert = Text.of(text.split(/\r\n|\r|\n/));
      const { main, ranges } = state.selection;
      view.dispatch({
        changes: { from, to, insert },
        selection:
          ranges.length === 1 && main.from === from && main.to === to
            ? { anchor: from + insert.length }
            : undefined,
        annotations: isolateHistory.of("full"),
      });
    },
    getProofreadingPassage: () =>
      view.compositionStarted ? null : prosePassageAtCursor(view.state),
    getSelection() {
      const { anchor, head } = view.state.selection.main;
      return { anchor: toFileOffset(view.state, anchor), head: toFileOffset(view.state, head) };
    },
    getAnnotationTarget() {
      const { state } = view;
      const focused = focusedTableCell(view);
      if (focused) return cellTarget(state, focused.table, focused.address);
      const { from, to } = state.selection.main;
      const object = markdownTarget(state, from, to);
      if (object) return object;
      const cell = annotationCellAt(state, from, to);
      if (cell) return cellTarget(state, cell.table, cell.address);
      return from === to ? null : textTarget(state, from, to);
    },
    revealAnnotation({ range, kind, implicitColumn }) {
      if (!range) return;
      const anchor = fromFileOffset(view.state, range.from);
      const head = fromFileOffset(view.state, range.from + range.source.length);
      if (kind === "cell" && mode === "livePreview") {
        const hit = annotationCellAt(view.state, anchor, head, implicitColumn);
        if (hit && focusTableCell(view, view.state.doc.lineAt(hit.table.from).from, hit.address))
          return;
      }
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
      view.focus();
    },
    getSelections() {
      return view.state.selection.ranges.map(({ anchor, head }) => ({
        anchor: toFileOffset(view.state, anchor),
        head: toFileOffset(view.state, head),
      }));
    },
    trackRange({ from, to }) {
      const range = {
        from: fromFileOffset(view.state, from),
        to: fromFileOffset(view.state, to),
      };
      trackedRanges.add(range);
      return {
        current: () => ({
          from: toFileOffset(view.state, range.from),
          to: toFileOffset(view.state, range.to),
        }),
        release: () => trackedRanges.delete(range),
      };
    },
    setSelections(ranges) {
      const selection = EditorSelection.create(
        ranges.map(({ anchor, head = anchor }) =>
          EditorSelection.range(
            fromFileOffset(view.state, anchor),
            fromFileOffset(view.state, head),
          ),
        ),
        ranges.length - 1,
      );
      view.dispatch({ selection });
    },
    setCodeBlockRenderers(renderers) {
      view.dispatch({ effects: fences.reconfigure(fencedRenderers(renderers)) });
    },
    getMode: () => mode,
    getSettings: () => settings,
    updateSettings(changes) {
      const previous = settings;
      settings = { ...settings, ...changes };
      const effects = preferences.reconfigure(previous, settings);
      if (settings.focusMode !== previous.focusMode) {
        effects.push(focus.reconfigure(focusExtension()));
      }
      if (settings.typewriterMode !== previous.typewriterMode) {
        effects.push(typewriter.reconfigure(typewriterExtension()));
        if (settings.typewriterMode) effects.push(centerCursor(view.state));
      }
      if (effects.length > 0) view.dispatch({ effects });
    },
    getOutline: () =>
      outline(view.state, true).map((heading) => ({
        ...heading,
        from: toFileOffset(view.state, heading.from),
      })),
    getWordCount: () => countWords(view.state),
    setSelection({ anchor, head = anchor, scrollIntoView = false }) {
      const selection = EditorSelection.single(
        fromFileOffset(view.state, anchor),
        fromFileOffset(view.state, head),
      );
      view.dispatch({
        selection,
        scrollIntoView: scrollIntoView === true,
        effects:
          scrollIntoView === "start"
            ? EditorView.scrollIntoView(selection.main.head, { y: "start", yMargin: 0 })
            : [],
      });
    },
    captureScrollPosition() {
      const snapshot = view.scrollSnapshot();
      return () => view.dispatch({ effects: snapshot });
    },
    getVisibleRange() {
      // The part of the scroller inside the window, in document coordinates.
      const box = view.scrollDOM.getBoundingClientRect();
      const top = Math.max(box.top, 0) - view.documentTop;
      const bottom = Math.min(box.bottom, window.innerHeight) - view.documentTop;
      const first = view.lineBlockAtHeight(Math.max(top, 0) + 1);
      const last = view.lineBlockAtHeight(Math.max(bottom - 1, top + 1));
      return {
        from: toFileOffset(view.state, first.from),
        to: toFileOffset(view.state, Math.max(first.to, last.to)),
      };
    },
    getFindStatus: () => findStatus(view.state),
    setInlineCompletion(request) {
      view.dispatch({ effects: completion.reconfigure(request ? inlineCompletion(request) : []) });
    },
    setDialect(dialect) {
      view.dispatch({ effects: syntax.reconfigure(dialectExtensions(dialect)) });
    },
    execute: (command, ...args) => (commands[command] as (...a: typeof args) => boolean)(...args),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Restore the native text selection after a dialog, while leaving a focused widget alone.
    focus: () => {
      const active = view.root.activeElement;
      if (active === view.contentDOM || !view.dom.contains(active)) view.focus();
    },
    destroy: () => {
      options.document?.detach(view);
      listeners.clear();
      trackedRanges.clear();
      view.destroy();
    },
  };
}
