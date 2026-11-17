import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
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
import { type LinkTarget, linkOpening } from "./links.ts";
import { inlineSpans } from "./live-preview/inline-spans.ts";
import { mathPreview } from "./live-preview/math.ts";
import { livePreview, previewRenderer } from "./live-preview/preview.ts";
import { themeable } from "./theme.ts";

/**
 * Capabilities the editor core needs from whatever hosts it (desktop shell,
 * a web page, tests). The core never talks to a platform directly; future
 * capabilities (resolving image paths, saving pasted images) are added here
 * as optional members.
 */
export interface HostAdapter {
  /** Open a link the user ⌘-clicked (Ctrl-clicked off macOS). Without it, links do nothing. */
  openLink?(link: LinkTarget): void;
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
  /** Switch between live preview and source mode. Text and selection are unchanged. */
  toggleSourceMode: [];
}
export type EditorCommand = keyof EditorCommands;

export type EditorEvent =
  | { readonly type: "change" }
  | { readonly type: "selection" }
  | { readonly type: "mode" };

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
  /** Select a range; with `scrollIntoView`, also scroll it into view (e.g. when jumping to a search result). */
  setSelection(selection: { anchor: number; head?: number; scrollIntoView?: boolean }): void;
  /** Matches of the find query set with the `setFindQuery` command. */
  getFindStatus(): FindStatus;
  /** Run a named command. Returns whether it did anything. */
  execute<C extends EditorCommand>(command: C, ...args: EditorCommands[C]): boolean;
  /** Listen for text, selection and mode changes. Returns an unsubscribe function. */
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
  const modeExtension = () => (mode === "livePreview" ? livePreview() : []);

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: parsed.doc,
      extensions: [
        parsed.extension,
        history(),
        findReplace(),
        keymap.of([
          ...defaultKeymap.filter((b) => !b.key || !hostKeys.has(b.key)),
          ...historyKeymap,
        ]),
        markdownSupport(dialect),
        themeable(),
        previewRenderer.of(inlineSpans),
        mathPreview(),
        preview.of(modeExtension()),
        host.openLink ? linkOpening((link) => host.openLink?.(link)) : [],
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit({ type: "change" });
          if (update.selectionSet) emit({ type: "selection" });
        }),
      ],
    }),
  });

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
