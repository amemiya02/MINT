import { type DocumentReference, documentReferences, type EditorDialect } from "@mint/editor";
import { indexWikilinks } from "../folder/wikilinks.ts";
import { documentExtensions, resolveFrom } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";

export interface FolderReference extends DocumentReference {
  readonly sourcePath: string;
  readonly targetPath: string;
}

/** Backlinks request one target. The graph requests all edges between listed documents. */
export async function folderReferences(
  platform: Platform,
  folder: string,
  dialect: EditorDialect,
  canRead: () => boolean,
  target?: string,
) {
  const results: FolderReference[] = [];
  if (!canRead()) return results;
  const paths = await platform.listFolderFiles(folder, documentExtensions);
  const targets = target === undefined ? new Set(paths) : new Set([target]);
  const wiki = dialect.wikilinks ? indexWikilinks(folder, paths) : null;
  for (const sourcePath of paths) {
    if (!canRead()) break;
    let source: string;
    try {
      source = await platform.readTextFile(sourcePath);
    } catch {
      continue; // A file can disappear between the directory walk and the read.
    }
    for (const ref of documentReferences(source, dialect)) {
      let targetPath: string;
      if (ref.target.wikilink) {
        const matches = wiki?.(sourcePath, ref.target.path);
        if (matches?.length !== 1 || !matches[0]) continue;
        targetPath = matches[0];
      } else {
        targetPath = ref.target.path ? resolveFrom(sourcePath, ref.target.path) : sourcePath;
      }
      if (targets.has(targetPath)) results.push({ ...ref, sourcePath, targetPath });
    }
  }
  return results;
}
