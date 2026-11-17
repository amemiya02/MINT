import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { type PreviewContext, type PreviewRenderer, previewRenderer } from "./preview.ts";

class BulletWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const bullet = document.createElement("span");
    bullet.className = "cm-mint-bullet";
    bullet.textContent = "•";
    return bullet;
  }
}

/**
 * A task checkbox. Clicking it flips the one character between the brackets
 * (`[ ]` ↔ `[x]`) and leaves the rest of the text and the selection alone.
 */
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-mint-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      toggleTask(view, view.posAtDOM(box));
    });
    // The document is the source of truth: the box is redrawn from it.
    box.addEventListener("click", (event) => event.preventDefault());
    box.addEventListener("keydown", (event) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      toggleTask(view, view.posAtDOM(box));
    });
    return box;
  }
  override ignoreEvent() {
    return true;
  }
}

/** Flip the task marker starting at `pos` (its `[`). */
function toggleTask(view: EditorView, pos: number) {
  const marker = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(marker)) return;
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: marker[1] === " " ? "x" : " " },
    userEvent: "input.toggle",
  });
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const checkbox = [false, true].map((checked) =>
  Decoration.replace({ widget: new CheckboxWidget(checked) }),
);
const orderedMark = Decoration.mark({ class: "cm-mint-list-number" });

function renderItem(item: SyntaxNode, cx: PreviewContext) {
  const mark = item.getChild("ListMark");
  if (!mark) return;
  const taskMarker = item.getChild("Task")?.getChild("TaskMarker");
  const ordered = item.parent?.name === "OrderedList";

  if (taskMarker) {
    if (
      cx.touchesSelection(mark.from, mark.to) ||
      cx.touchesSelection(taskMarker.from, taskMarker.to)
    ) {
      return;
    }
    // The checkbox stands in for the whole `- [ ]`.
    const space = cx.state.sliceDoc(mark.to, mark.to + 1) === " " ? 1 : 0;
    cx.hide(mark.from, mark.to + space);
    const checked = cx.state.sliceDoc(taskMarker.from + 1, taskMarker.from + 2) !== " ";
    cx.add(taskMarker.from, taskMarker.to, checkbox[checked ? 1 : 0] as Decoration);
    return;
  }

  if (ordered) cx.add(mark.from, mark.to, orderedMark);
  else if (!cx.touchesSelection(mark.from, mark.to)) cx.add(mark.from, mark.to, bullet);
}

const renderer: PreviewRenderer = {
  nodes: ["ListItem"],
  render(node, cx) {
    renderItem(node, cx);
    return undefined;
  },
};

const theme = EditorView.baseTheme({
  ".cm-mint-bullet": { color: "var(--mint-marker, #8a9099)" },
  ".cm-mint-list-number": { color: "var(--mint-marker, #8a9099)" },
  ".cm-mint-task": { margin: "0 0.3em 0 0", verticalAlign: "middle", cursor: "pointer" },
});

/** Bullet, ordered and task lists. Enter continues them (see markup-continuation.ts). */
export const lists: Extension = [previewRenderer.of(renderer), theme];
