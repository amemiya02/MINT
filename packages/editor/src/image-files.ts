import { type ChangeDesc, type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** An image file the user pasted or dropped into the editor. */
export interface ImageFile {
  /** The file name the platform gave it (pasted screenshots usually get a generic one). */
  readonly name: string;
  /** MIME type, e.g. `image/png`. */
  readonly type: string;
  readonly data: Uint8Array;
  /** `paste`: from the clipboard; `drop`: a file dragged into the editor. */
  readonly origin: "paste" | "drop";
}

/**
 * Stores an image file (in the asset folder) and resolves to the path of the
 * stored file, relative to the document (`/`-separated). The editor writes it
 * into the document as an image reference. If it rejects, the file is
 * skipped: reporting the failure is up to the host.
 */
export type ImageSaver = (file: ImageFile) => Promise<string>;

/** Where references to images still being saved will go, mapped through edits made meanwhile. */
interface Pending {
  readonly id: number;
  readonly from: number;
  readonly to: number;
}

const addPending = StateEffect.define<Pending>();
const removePending = StateEffect.define<number>();

const pendingInserts = StateField.define<readonly Pending[]>({
  create: () => [],
  update(pending, tr) {
    let next = tr.docChanged ? pending.map((p) => mapPending(p, tr.changes)) : pending;
    for (const effect of tr.effects) {
      if (effect.is(addPending)) next = [...next, effect.value];
      if (effect.is(removePending)) next = next.filter((p) => p.id !== effect.value);
    }
    return next;
  },
});

function mapPending(p: Pending, changes: ChangeDesc): Pending {
  const from = changes.mapPos(p.from, 1);
  return { id: p.id, from, to: Math.max(from, changes.mapPos(p.to, -1)) };
}

/** Characters that would end or break a Markdown link destination are percent-encoded. */
export function imageDestination(path: string): string {
  return path.replace(/[%\s()<>[\]\\]/g, (c) => encodeURIComponent(c));
}

/** Alt text for a saved image: its file name without extension, safe inside `[...]`. */
function altFor(path: string): string {
  const name = path.split("/").pop() ?? path;
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return stem.replace(/[[\]\\]/g, "\\$&");
}

let nextId = 0;

async function insertImages(
  view: EditorView,
  files: readonly File[],
  origin: ImageFile["origin"],
  at: { from: number; to: number },
  save: ImageSaver,
) {
  const id = nextId++;
  view.dispatch({ effects: addPending.of({ id, ...at }) });
  const references: string[] = [];
  try {
    for (const file of files) {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const path = await save({ name: file.name, type: file.type, data, origin });
        references.push(`![${altFor(path)}](${imageDestination(path)})`);
      } catch {
        // Skipped; the host reports why.
      }
    }
  } finally {
    // The view may have been destroyed while saving.
    const pending = view.state.field(pendingInserts, false)?.find((p) => p.id === id);
    if (pending) {
      const insert = references.join(view.state.lineBreak);
      view.dispatch({
        effects: removePending.of(id),
        ...(insert
          ? {
              changes: { from: pending.from, to: pending.to, insert },
              selection: { anchor: pending.from + insert.length },
              userEvent: `input.${origin}`,
              scrollIntoView: true,
            }
          : {}),
      });
    }
  }
}

function dropPosition(view: EditorView, event: DragEvent): number | null {
  try {
    return view.posAtCoords({ x: event.clientX, y: event.clientY });
  } catch {
    // Without layout (e.g. no rendering engine) there is no position under the pointer.
    return null;
  }
}

function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((file) => file.type.startsWith("image/"));
}

/**
 * Pasting or dropping image files hands them to `save` and inserts a reference
 * to each saved file, one per line, where they were pasted or dropped.
 */
export function imageFileInsertion(save: ImageSaver): Extension {
  return [
    pendingInserts,
    EditorView.domEventHandlers({
      paste(event, view) {
        const files = imageFiles(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        const { from, to } = view.state.selection.main;
        void insertImages(view, files, "paste", { from, to }, save);
        return true;
      },
      drop(event, view) {
        const files = imageFiles(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        const pos = dropPosition(view, event) ?? view.state.selection.main.head;
        void insertImages(view, files, "drop", { from: pos, to: pos }, save);
        return true;
      },
    }),
  ];
}
