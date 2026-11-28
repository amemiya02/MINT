import { documentReferences, type EditorDialect } from "@mint/editor";
import { indexWikilinks } from "../folder/wikilinks.ts";
import { isAbsolutePath, isDocumentPath, joinPath, resolveFrom } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import type { TabStore } from "../tabs/tab-store.ts";
import { selectionEdits } from "./selection-edits.ts";
import type { TaskCopyChange, TaskCopyDocument } from "./writing-sender.ts";

export type FolderChange = TaskCopyChange & {
  readonly before?: string;
  readonly requires: readonly string[];
  readonly status: "preview" | "applied" | "discarded" | "outside";
};

export function isFolderDocumentPath(path: string) {
  return (
    isDocumentPath(path) &&
    !/[<>:"\\|?*\p{Cc}]/u.test(path) &&
    path.split("/").every((part) => part && !part.startsWith(".") && !/[. ]$/.test(part))
  );
}

export function planFolderChanges(
  root: string,
  documents: readonly TaskCopyDocument[],
  changes: readonly TaskCopyChange[],
  availablePaths: readonly string[],
  dialect: EditorDialect,
): FolderChange[] {
  const originals = new Map(documents.map(({ path, text }) => [path, text]));
  const knownPaths = new Set(availablePaths);
  const destinations = new Set<string>();
  const sources = new Set<string>();
  const proposals: FolderChange[] = [];
  for (const change of changes) {
    if (
      typeof change?.path !== "string" ||
      typeof change.text !== "string" ||
      (change.from !== undefined && typeof change.from !== "string")
    )
      continue;
    const { path, from, text } = change;
    const before = originals.get(from ?? path);
    if (
      !isFolderDocumentPath(path) ||
      (from !== undefined && (!originals.has(from) || from === path || originals.has(path))) ||
      destinations.has(path) ||
      sources.has(from ?? path) ||
      (before === undefined && knownPaths.has(joinPath(root, path)))
    ) {
      proposals.push({ path, from, text: "", requires: [], status: "outside" });
      continue;
    }
    destinations.add(path);
    sources.add(from ?? path);
    const after = before === undefined ? text : preserveSource(before, text);
    if (from !== undefined || before !== after)
      proposals.push({ path, from, text: after, before, requires: [], status: "preview" });
  }

  const newPaths = new Map(
    proposals
      .filter(
        (change) =>
          change.status === "preview" && (change.before === undefined || change.from !== undefined),
      )
      .map(({ path }) => [joinPath(root, path), path]),
  );
  if (!newPaths.size) return proposals;
  const movedPaths = new Set(
    proposals.flatMap(({ status, from }) =>
      status === "preview" && from ? [joinPath(root, from)] : [],
    ),
  );
  const wiki = indexWikilinks(root, [
    ...availablePaths.filter((path) => !movedPaths.has(path)),
    ...newPaths.keys(),
  ]);
  return proposals.map((change) => {
    if (change.status === "outside") return change;
    const requires = new Set<string>();
    const source = joinPath(root, change.path);
    for (const { target } of documentReferences(change.text, dialect)) {
      if (!target.path) continue;
      const resolved = target.wikilink
        ? wiki(source, target.path)
        : isAbsolutePath(target.path)
          ? []
          : [resolveFrom(source, target.path)];
      const destination = resolved.length === 1 && resolved[0];
      const dependency = destination && newPaths.get(destination);
      if (dependency && dependency !== change.path) requires.add(dependency);
    }
    return { ...change, requires: [...requires].sort() };
  });
}

/** Keep the manuscript's BOM and line endings in unchanged passages. */
function preserveSource(before: string, text: string) {
  if (before === text) return before;
  const proposed =
    before.startsWith("\uFEFF") && !text.startsWith("\uFEFF") ? `\uFEFF${text}` : text;
  const parts: string[] = [];
  let end = 0;
  for (const { from, to, after } of selectionEdits(before, proposed)) {
    parts.push(before.slice(end, from), after);
    end = to;
  }
  return parts.join("") + before.slice(end);
}

/** Open manuscript edits use the shared editor and its normal save mode. */
export async function applyFolderChange(
  platform: Platform,
  store: TabStore,
  root: string,
  change: FolderChange,
): Promise<"applied" | "conflict" | "saveFirst"> {
  const { path, from, before, text } = change;
  const to = joinPath(root, path);
  const source = joinPath(root, from ?? path);
  const open = () => store.getState().tabs.find((tab) => tab.path === source);
  const tab = open();
  if (before !== undefined && tab) {
    if (!(await store.refreshDisk(tab.id))) return "conflict";
    const liveTab = open();
    if (!liveTab) return "conflict";
    const editor = store.editor(liveTab.id);
    if (!editor || editor.getText() !== before) return "conflict";
    if (from === undefined) {
      editor.replaceRanges(
        selectionEdits(before, text).map(({ from, to, after }) => ({ from, to, text: after })),
        { lineEndings: "preserve" },
      );
      return "applied";
    }
    if (liveTab.dirty) return "saveFirst";
  }
  await platform.applyFolderDocumentEdit(root, { from: source, to, before, after: text });
  if (from !== undefined) store.pathRenamed(source, to);
  return "applied";
}
