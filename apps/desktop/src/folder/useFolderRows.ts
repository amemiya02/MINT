import { useSyncExternalStore } from "react";
import type { FolderTree } from "./file-tree.ts";

const noSubscription = () => () => {};
const noRows = () => null;

export function useFolderRows(tree: FolderTree | null) {
  return useSyncExternalStore(tree?.subscribe ?? noSubscription, tree?.getRows ?? noRows);
}
