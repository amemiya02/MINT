import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * Typewriter mode: the line with the cursor is kept at the vertical middle of
 * the editor. Every edit and keyboard selection change scrolls the cursor to
 * the middle (pointer selections are left where the user clicked, so a drag
 * does not run away), and space above and below the text, half the editor's
 * height, lets even the first and last lines reach the middle. The editor gets
 * the `cm-mint-typewriter-mode` class.
 */

/** Scroll the main cursor to the vertical middle. */
export function centerCursor(state: EditorState) {
  return EditorView.scrollIntoView(state.selection.main.head, { y: "center" });
}

const keepCentered = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged && !tr.selection) return null;
  if (tr.isUserEvent("select.pointer")) return null;
  return {
    effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: "center" }),
  };
});

/** The space around the text, in a custom property on the scroller (not part of the theme contract). */
const space = "--cm-mint-typewriter-space";

/** Sizes the space around the text from the editor's height, which only layout knows. */
const spacing = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.measure();
    }
    update(update: ViewUpdate) {
      if (update.geometryChanged) this.measure();
    }
    measure() {
      this.view.requestMeasure({
        key: this,
        read: (view) => Math.max(0, (view.scrollDOM.clientHeight - view.defaultLineHeight) / 2),
        write: (half, view) => {
          const value = `${Math.round(half)}px`;
          if (view.scrollDOM.style.getPropertyValue(space) !== value) {
            view.scrollDOM.style.setProperty(space, value);
          }
        },
      });
    }
    destroy() {
      this.view.scrollDOM.style.removeProperty(space);
    }
  },
);

const typewriterTheme = EditorView.baseTheme({
  "&.cm-mint-typewriter-mode .cm-content": {
    paddingTop: `var(${space}, 40vh)`,
    paddingBottom: `var(${space}, 40vh)`,
  },
});

export function typewriterMode(): Extension {
  return [
    keepCentered,
    spacing,
    EditorView.editorAttributes.of({ class: "cm-mint-typewriter-mode" }),
    typewriterTheme,
  ];
}
