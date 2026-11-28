import { type DocumentReference, documentReferences, type EditorDialect } from "@mint/editor";
import { indexWikilinks } from "../folder/wikilinks.ts";
import { documentExtensions, resolveFrom } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";

export interface Backlink extends DocumentReference {
  readonly sourcePath: string;
}

export async function findBacklinks(
  platform: Platform,
  folder: string,
  targetPath: string,
  dialect: EditorDialect,
  signal: AbortSignal,
) {
  const results: Backlink[] = [];
  const paths = await platform.listFolderFiles(folder, documentExtensions);
  const wiki = dialect.wikilinks ? indexWikilinks(folder, paths) : null;
  for (const sourcePath of paths) {
    if (signal.aborted) break;
    let source: string;
    try {
      source = await platform.readTextFile(sourcePath);
    } catch {
      continue; // A file can disappear between the directory walk and the read.
    }
    for (const ref of documentReferences(source, dialect)) {
      if (ref.target.wikilink) {
        const matches = wiki?.(sourcePath, ref.target.path);
        if (matches?.length === 1 && matches[0] === targetPath)
          results.push({ ...ref, sourcePath });
      } else {
        const path = ref.target.path ? resolveFrom(sourcePath, ref.target.path) : sourcePath;
        if (path === targetPath) results.push({ ...ref, sourcePath });
      }
    }
  }
  return results;
}
