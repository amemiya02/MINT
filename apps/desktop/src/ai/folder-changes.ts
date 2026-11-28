import { documentReferences, type EditorDialect, type MintEditor } from "@mint/editor";
import { indexWikilinks } from "../folder/wikilinks.ts";
import { isAbsolutePath, isDocumentPath, joinPath, resolveFrom } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import type { TabStore } from "../tabs/tab-store.ts";
import { selectionEdits } from "./selection-edits.ts";
import type { TaskCopyChange, TaskCopyDocument } from "./writing-sender.ts";
import { mapReviewRanges } from "./writing-tasks.ts";

export type FolderChange = TaskCopyChange & {
  readonly before?: string;
  readonly diskBefore?: string;
  readonly requires: readonly string[];
  readonly status: "preview" | "applied" | "discarded" | "outside" | "reverted" | "kept";
  readonly result?: "failed" | "conflict" | "deferred";
  readonly current?: string;
  readonly undoResult?: "failed" | "conflict" | "deferred";
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
  writeTargets?: readonly string[],
  diskBaselines?: ReadonlyMap<string, string>,
): FolderChange[] {
  const originals = new Map(documents.map(({ path, text }) => [path, text]));
  const knownPaths = new Set(availablePaths);
  const destinations = new Set<string>();
  const sources = new Set<string>();
  const authorized = writeTargets && new Set(writeTargets);
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
      (authorized && (!authorized.has(path) || (from !== undefined && !authorized.has(from)))) ||
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
      proposals.push({
        path,
        from,
        text: after,
        before,
        diskBefore: diskBaselines?.get(from ?? path),
        requires: [],
        status: "preview",
      });
  }

  const newPaths = new Map(
    proposals
      .filter(({ path, before, from, status }) =>
        status === "outside"
          ? authorized && isFolderDocumentPath(path) && !knownPaths.has(joinPath(root, path))
          : before === undefined || from !== undefined,
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
      replaceFolderText(editor, before, text);
      return "applied";
    }
    if (liveTab.dirty) return "saveFirst";
  }
  await platform.applyFolderDocumentEdit(root, { from: source, to, before, after: text });
  if (from !== undefined) store.pathRenamed(source, to);
  return "applied";
}

/** Execute only pending authorized changes, in dependency order. */
export async function writeFolderBatch(
  platform: Platform,
  store: TabStore,
  root: string,
  proposals: readonly FolderChange[],
  signal?: AbortSignal,
): Promise<FolderChange[]> {
  const changes = [...proposals];
  const applied = new Set(
    changes.filter(({ status }) => status === "applied").map(({ path }) => path),
  );
  const pending = changes.flatMap(({ status }, index) => (status === "preview" ? [index] : []));
  while (pending.length && !signal?.aborted) {
    const ready = pending.findIndex((index) =>
      changes[index]?.requires.every((path) => applied.has(path)),
    );
    if (ready === -1) {
      for (const index of pending) {
        const change = changes[index];
        if (change) changes[index] = { ...change, result: "deferred" };
      }
      break;
    }
    const [index] = pending.splice(ready, 1);
    if (index === undefined) break;
    const change = changes[index];
    if (!change) continue;
    const { path, from, before, text } = change;
    const source = joinPath(root, from ?? path);
    try {
      const dependencies = await Promise.allSettled(
        change.requires.map((target) => platform.readTextFile(joinPath(root, target))),
      );
      if (dependencies.some(({ status }) => status === "rejected")) {
        changes[index] = { ...change, result: "deferred" };
        continue;
      }
      const disk = before === undefined ? undefined : await platform.readTextFile(source);
      const tab = store.getState().tabs.find(({ path }) => path === source);
      const live = tab && store.getText(tab.id);
      if (
        before !== undefined &&
        ((disk !== before && (live !== before || disk !== change.diskBefore)) ||
          (live != null && live !== before) ||
          (live == null && tab?.dirty))
      ) {
        changes[index] = { ...change, result: "conflict", current: live ?? disk };
        continue;
      }
      if (signal?.aborted) break;
      const written = await store.writeFolderEdit(
        root,
        { from: source, to: joinPath(root, path), before: disk, after: text },
        (editor) => {
          if (before === undefined || editor.getText() !== before) return false;
          replaceFolderText(editor, before, text);
          return true;
        },
      );
      changes[index] = written
        ? { ...change, status: "applied", result: undefined, current: undefined }
        : { ...change, result: "conflict" };
      if (written) applied.add(path);
    } catch {
      changes[index] = { ...change, result: "failed" };
    }
  }
  return changes;
}

function replaceFolderText(editor: MintEditor, before: string, after: string) {
  editor.replaceRanges(
    selectionEdits(before, after).map(({ from, to, after }) => ({ from, to, text: after })),
    { lineEndings: "preserve" },
  );
}

/** Revert backlinks before their destinations. Failed or kept backlinks still hold them. */
export async function revertFolderBatch(
  platform: Platform,
  store: TabStore,
  root: string,
  proposals: readonly FolderChange[],
  position?: number,
): Promise<FolderChange[]> {
  const changes = [...proposals];
  const pending = changes.flatMap(({ status }, index) =>
    status === "applied" && (position === undefined || index === position) ? [index] : [],
  );
  const isRequired = (path: string) =>
    changes.some(
      ({ status, requires }) =>
        (status === "applied" || status === "kept") && requires.includes(path),
    );
  while (pending.length) {
    const ready = pending.findIndex((index) => {
      const change = changes[index];
      return change && !isRequired(change.path);
    });
    if (ready === -1) {
      for (const index of pending) {
        const change = changes[index];
        if (change) changes[index] = { ...change, undoResult: "deferred" };
      }
      break;
    }
    const [index] = pending.splice(ready, 1);
    if (index === undefined) break;
    const change = changes[index];
    if (change) changes[index] = await revertFolderChange(platform, store, root, change);
  }
  return changes;
}

async function revertFolderChange(
  platform: Platform,
  store: TabStore,
  root: string,
  change: FolderChange,
): Promise<FolderChange> {
  const { path, from, before, text } = change;
  const source = joinPath(root, path);
  try {
    const disk = await platform.readTextFile(source);
    const tab = store.getState().tabs.find(({ path }) => path === source);
    const live = tab && store.getText(tab.id);
    const current = live ?? disk;
    if (
      tab?.external ||
      (live == null && tab?.dirty) ||
      (before === undefined && (disk !== text || current !== text))
    )
      return { ...change, undoResult: "conflict", current };
    const diskAfter = before === undefined ? undefined : reverseDocumentEdit(text, before, disk);
    const liveAfter =
      before === undefined
        ? undefined
        : current === disk
          ? diskAfter
          : reverseDocumentEdit(text, before, current);
    if (diskAfter === null || liveAfter === null)
      return { ...change, undoResult: "conflict", current: diskAfter === null ? disk : current };
    const reverted = await store.writeFolderEdit(
      root,
      { from: source, to: joinPath(root, from ?? path), before: disk, after: diskAfter },
      (editor) => {
        if (editor.getText() !== current) return false;
        if (liveAfter !== undefined) replaceFolderText(editor, current, liveAfter);
        return true;
      },
    );
    return reverted
      ? { ...change, status: "reverted", undoResult: undefined, current: undefined }
      : { ...change, undoResult: "conflict", current };
  } catch {
    return { ...change, undoResult: "failed", current: undefined };
  }
}

/** Use the saved before/after and only reverse spans whose applied text is still present. */
function reverseDocumentEdit(applied: string, original: string, current: string) {
  if (current === applied) return original;
  const mapper = mapReviewRanges(applied, current);
  const parts: string[] = [];
  let end = 0;
  for (const { from, to, start, end: replacementEnd } of mapReviewRanges(applied, original)
    .changes) {
    const range = mapper.range({ from, to, located: true });
    if (
      !range.located ||
      range.from < end ||
      current.slice(range.from, range.to) !== applied.slice(from, to)
    )
      return null;
    parts.push(current.slice(end, range.from), original.slice(start, replacementEnd));
    end = range.to;
  }
  return parts.join("") + current.slice(end);
}
