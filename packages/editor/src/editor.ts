import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { type Dialect, defaultDialect } from "@mint/markdown";
import { fileText, fromFileOffset, parseFileText, toFileOffset } from "./file-text.ts";
import {
  type FindCommands,
  type FindStatus,
  findCommands,
  findReplace,
  findStatus,
} from "./find.ts";

/**
 * Capabilities the editor core needs from whatever hosts it (desktop shell,
 * a web page, tests). The core never talks to a platform directly; future
 * capabilities (resolving image paths, saving pasted images, opening links)
 * are added here as optional members.
 */
// biome-ignore lint/suspicious/noEmptyInterface: injection point, members arrive with later features.
export interface HostAdapter {}

export interface EditorOptions {
  /** Element the editor mounts into. */
  readonly parent: HTMLElement;
  /** Full file text, exactly as decoded from disk (a leading U+FEFF BOM and any line endings are kept). */
  readonly text: string;
  readonly dialect?: Dialect;
  readonly host?: HostAdapter;
}

/** A selection range in {@link MintEditor.getText} offsets (UTF-16 code units). */
export interface TextSelection {
  readonly anchor: number;
  readonly head: number;
}

/** Named commands and their arguments. */
export interface EditorCommands extends FindCommands {
  undo: [];
  redo: [];
  /** Replace the selection with text, as if typed. Line breaks take the document's line ending. */
  insertText: [text: string];
}
export type EditorCommand = keyof EditorCommands;

export type EditorEvent = { readonly type: "change" } | { readonly type: "selection" };

export interface MintEditor {
  /** The full file text, ready to be written to disk byte for byte. */
  getText(): string;
  getSelection(): TextSelection;
  setSelection(selection: { anchor: number; head?: number }): void;
  /** Matches of the find query set with the `setFindQuery` command. */
  getFindStatus(): FindStatus;
  /** Run a named command. Returns whether it did anything. */
  execute<C extends EditorCommand>(command: C, ...args: EditorCommands[C]): boolean;
  /** Listen for text and selection changes. Returns an unsubscribe function. */
  subscribe(listener: (event: EditorEvent) => void): () => void;
  focus(): void;
  destroy(): void;
}

export function createEditor(options: EditorOptions): MintEditor {
  const listeners = new Set<(event: EditorEvent) => void>();
  const parsed = parseFileText(options.text);
  const dialect = options.dialect ?? defaultDialect;

  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: parsed.doc,
      extensions: [
        parsed.extension,
        history(),
        findReplace(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: commonmarkLanguage, extensions: dialect.gfm ? [GFM] : [] }),
        syntaxHighlighting(defaultHighlightStyle),
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
    undo: () => undo(view),
    redo: () => redo(view),
    insertText: (text) => {
      view.dispatch(view.state.replaceSelection(text), {
        userEvent: "input.type",
        scrollIntoView: true,
      });
      return true;
    },
  };

  return {
    getText: () => fileText(view.state),
    getSelection() {
      const { anchor, head } = view.state.selection.main;
      return { anchor: toFileOffset(view.state, anchor), head: toFileOffset(view.state, head) };
    },
    setSelection({ anchor, head = anchor }) {
      view.dispatch({
        selection: EditorSelection.single(
          fromFileOffset(view.state, anchor),
          fromFileOffset(view.state, head),
        ),
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
