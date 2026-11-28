import { baseName, parentPath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import type { TabStore } from "../tabs/tab-store.ts";
import {
  type FolderChange,
  type FolderMutation,
  revertFolderBatch,
  writeFolderBatch,
} from "./folder-changes.ts";
import type { SavedTurn } from "./writing-tasks.ts";

export interface FolderBatchJournal {
  readonly turn: SavedTurn;
  readonly turnIndex: number;
  readonly operation: "write" | "revert";
  readonly mutation: FolderMutation;
}

export async function runFolderBatch({
  platform,
  store,
  root,
  turn,
  turnIndex,
  operation,
  position,
  signal,
  checkpoint,
}: {
  readonly platform: Platform;
  readonly store: TabStore;
  readonly root: string;
  readonly turn: SavedTurn;
  readonly turnIndex: number;
  readonly operation: "write" | "revert";
  readonly position?: number;
  readonly signal?: AbortSignal;
  readonly checkpoint?: (journal: FolderBatchJournal) => Promise<void>;
}) {
  const changes = turn.folderChanges ?? [];
  const save = checkpoint
    ? (progress: readonly FolderChange[], mutation: FolderMutation) =>
        checkpoint({
          turn: { ...turn, folderChanges: [...progress] },
          turnIndex,
          operation,
          mutation,
        })
    : undefined;
  return operation === "write"
    ? writeFolderBatch(platform, store, root, changes, signal, save)
    : revertFolderBatch(platform, store, root, changes, position, save);
}

/** Read the interrupted step's disk result once. Resume review without replaying any writes. */
export async function reconcileFolderBatch(
  platform: Platform,
  { turn, turnIndex, operation, mutation }: FolderBatchJournal,
  turns: readonly SavedTurn[],
): Promise<readonly SavedTurn[]> {
  const { from, to, before, after, index } = mutation;
  const inspect = async (path: string): Promise<string | undefined | null> => {
    try {
      return await platform.readTextFile(path);
    } catch {
      // A missing file differs from a file we cannot read. Directory entries
      // let the Platform establish absence without interpreting OS error text.
      try {
        const items = await platform.readDirectory(parentPath(path));
        return items.some(({ name }) => name === baseName(path)) ? null : undefined;
      } catch {
        return null;
      }
    }
  };
  const source = await inspect(from);
  const destination = from === to ? source : await inspect(to);
  const applied = destination === after && (from === to || source === undefined);
  const unchanged = source === before && (from === to || destination === undefined);
  const changes = turn.folderChanges?.map((change, position): FolderChange => {
    if (position !== index) return change;
    if (operation === "revert") {
      return applied
        ? { ...change, status: "reverted", undoResult: undefined, current: undefined }
        : unchanged
          ? change
          : { ...change, undoResult: "conflict", current: source ?? undefined };
    }
    return applied
      ? { ...change, status: "applied", result: undefined, current: undefined }
      : unchanged
        ? change
        : { ...change, result: "conflict", current: source ?? undefined };
  });
  const result = [...turns];
  result[turnIndex] = { ...turn, folderChanges: changes };
  return result;
}
