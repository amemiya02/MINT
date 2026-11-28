import { type DocumentReference, documentReferences } from "@mint/editor";
import type { Dialect } from "@mint/markdown";
import { documentExtensions, resolveFrom } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";

export interface Backlink extends DocumentReference {
  readonly sourcePath: string;
}

export async function findBacklinks(
  platform: Platform,
  folder: string,
  targetPath: string,
  dialect: Dialect,
  signal: AbortSignal,
) {
  const results: Backlink[] = [];
  for (const sourcePath of await platform.listFolderFiles(folder, documentExtensions)) {
    if (signal.aborted) break;
    let source: string;
    try {
      source = await platform.readTextFile(sourcePath);
    } catch {
      continue; // A file can disappear between the directory walk and the read.
    }
    for (const ref of documentReferences(source, dialect)) {
      const path = ref.target.path ? resolveFrom(sourcePath, ref.target.path) : sourcePath;
      if (path === targetPath) results.push({ ...ref, sourcePath });
    }
  }
  return results;
}
