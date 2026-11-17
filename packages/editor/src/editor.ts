import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { type Dialect, defaultDialect } from "@mint/markdown";
import { markdownSupport } from "./dialect.ts";
import {
  fileText,
  fromFileOffset,
  parseFileText,
  replaceFileText,
  toFileOffset,
} from "./file-text.ts";
import {
  type FindCommands,
  type FindStatus,
  findCommands,
  findReplace,
  findStatus,
} from "./find.ts";
import { type FormattingCommands, formattingCommands } from "./formatting.ts";
import { type ImageFile, imageFileInsertion } from "./image-files.ts";
import { type LinkTarget, linkOpening } from "./links.ts";
import { codeBlocks, setCodeBlockLanguage } from "./live-preview/code-blocks.ts";
import { footnotes } from "./live-preview/footnotes.ts";
import { frontMatterPreview } from "./live-preview/front-matter.ts";
import { headings } from "./live-preview/headings.ts";
import { imagePreview, imageUrlResolver } from "./live-preview/images.ts";
import { inlineSpans } from "./live-preview/inline-spans.ts";
import { lists } from "./live-preview/lists.ts";
import { mathPreview } from "./live-preview/math.ts";
import { mermaidDiagrams } from "./live-preview/mermaid.ts";
import { livePreview, previewRenderer } from "./live-preview/preview.ts";
import { quotesAndRules } from "./live-preview/quotes-and-rules.ts";
import { markupContinuation } from "./markup-continuation.ts";
import { type OutlineHeading, outline, sameOutline } from "./outline.ts";
import { type EditorPreferences, editorPreferences } from "./preferences.ts";
import { pasteText, richPaste } from "./rich-paste.ts";
import { themeable } from "./theme.ts";

/**
 * Capabilities the editor core needs from whatever hosts it (desktop shell,
 * a web page, tests). The core never talks to a platform directly; future
 * capabilities are added here as optional members.
 */
export interface HostAdapter {
  /** Open a link the user ⌘-clicked (Ctrl-clicked off macOS). Without it, links do nothing. */
  openLink?(link: LinkTarget): void;
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

export interface EditorOptions {
  /** Element the editor mounts into. */
  readonly parent: HTMLElement;
  /** Full file text, exactly as decoded from disk (a leading U+FEFF BOM and any line endings are kept). */
  readonly text: string;
  readonly dialect?: Dialect;
  readonly host?: HostAdapter;
  /** Initial mode; defaults to `livePreview`. */
  readonly mode?: EditorMode;
  /** Vim key bindings; off by default. Switch later with {@link MintEditor.configure}. */
  readonly vim?: boolean;
  /** System spellchecking; off by default. Switch later with {@link MintEditor.configure}. */
  readonly spellcheck?: boolean;
}

/** A selection range in {@link MintEditor.getText} offsets (UTF-16 code units). */
export interface TextSelection {
  readonly anchor: number;
  readonly head: number;
}

/** Named commands and their arguments. */
export interface EditorCommands extends FindCommands, FormattingCommands {
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
  /** Set the language of the fenced code block at the cursor; only its info string changes. */
  setCodeBlockLanguage: [language: string];
}
export type EditorCommand = keyof EditorCommands;

export type EditorEvent =
  | { readonly type: "change" }
  | { readonly type: "selection" }
  | { readonly type: "mode" }
  /** The headings returned by {@link MintEditor.getOutline} changed. */
  | { readonly type: "outline" };

export interface MintEditor {
  /** The full file text, ready to be written to disk byte for byte. */
  getText(): string;
  /**
   * Replace the whole text with new file text, e.g. the document reloaded from
   * disk. The selection stays next to the text around it; undo restores the old text.
   */
  replaceText(text: string): void;
  getSelection(): TextSelection;
  getMode(): EditorMode;
  getPreferences(): EditorPreferences;
  /** Switch preferences (Vim key bindings, spellchecking) on or off; text and selection are kept. */
  configure(preferences: Partial<EditorPreferences>): void;
  /** The outline: every heading in document order, with its level, text and position. */
  getOutline(): readonly OutlineHeading[];
  /** Select a range; with `scrollIntoView`, also scroll it into view (e.g. when jumping to a search result). */
  setSelection(selection: { anchor: number; head?: number; scrollIntoView?: boolean }): void;
  /** Matches of the find query set with the `setFindQuery` command. */
  getFindStatus(): FindStatus;
  /** Run a named command. Returns whether it did anything. */
  execute<C extends EditorCommand>(command: C, ...args: EditorCommands[C]): boolean;
  /** Listen for text, selection, mode and outline changes. Returns an unsubscribe function. */
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

export function createEditor(options: EditorOptions): MintEditor {
  const listeners = new Set<(event: EditorEvent) => void>();
  const parsed = parseFileText(options.text);
  const dialect = options.dialect ?? defaultDialect;
  const host = options.host ?? {};
  const preview = new Compartment();
  let mode: EditorMode = options.mode ?? "livePreview";
  let lastOutline: readonly OutlineHeading[] = [];
  const preferences = editorPreferences({
    vim: options.vim ?? false,
    spellcheck: options.spellcheck ?? false,
  });
  const modeExtension = () => (mode === "livePreview" ? livePreview() : []);

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: parsed.doc,
      extensions: [
        parsed.extension,
        preferences.extension,
        history(),
        findReplace(),
        keymap.of([
          ...defaultKeymap.filter((b) => !b.key || !hostKeys.has(b.key)),
          ...historyKeymap,
        ]),
        markdownSupport(dialect),
        markupContinuation,
        themeable(),
        previewRenderer.of(inlineSpans),
        mathPreview(),
        headings,
        lists,
        quotesAndRules,
        footnotes,
        // Mermaid takes over its fences from codeBlocks (it matches only ```mermaid; the rest stay code blocks).
        dialect.mermaid ? mermaidDiagrams() : [],
        codeBlocks,
        imagePreview(),
        host.resolveImageUrl
          ? imageUrlResolver.of((path) => host.resolveImageUrl?.(path) ?? null)
          : [],
        host.saveImage ? imageFileInsertion(host.saveImage.bind(host)) : [],
        richPaste(dialect),
        frontMatterPreview,
        preview.of(modeExtension()),
        host.openLink ? linkOpening((link) => host.openLink?.(link)) : [],
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit({ type: "change" });
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

  lastOutline = outline(view.state, false);

  function emit(event: EditorEvent) {
    for (const listener of listeners) listener(event);
  }

  const commands: { [C in EditorCommand]: (...args: EditorCommands[C]) => boolean } = {
    ...findCommands(view),
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
    getSelection() {
      const { anchor, head } = view.state.selection.main;
      return { anchor: toFileOffset(view.state, anchor), head: toFileOffset(view.state, head) };
    },
    getMode: () => mode,
    getPreferences: () => preferences.get(),
    configure: (next) => preferences.configure(view, next),
    getOutline: () =>
      outline(view.state, true).map((heading) => ({
        ...heading,
        from: toFileOffset(view.state, heading.from),
      })),
    setSelection({ anchor, head = anchor, scrollIntoView = false }) {
      view.dispatch({
        selection: EditorSelection.single(
          fromFileOffset(view.state, anchor),
          fromFileOffset(view.state, head),
        ),
        scrollIntoView,
      });
    },
    getFindStatus: () => findStatus(view.state),
    execute: (command, ...args) => (commands[command] as (...a: typeof args) => boolean)(...args),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    focus: () => view.focus(),
    destroy: () => {
      listeners.clear();
      view.destroy();
    },
  };
}
