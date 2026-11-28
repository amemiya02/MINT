import { type DocumentReference, documentReferences, type EditorDialect } from "@mint/editor";
import { indexWikilinks } from "../folder/wikilinks.ts";
import { documentExtensions, resolveFrom } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";

export interface FolderReference extends DocumentReference {
  readonly sourceText: string;
  readonly dialect: EditorDialect;
  readonly sourcePath: string;
  readonly targetPath: string;
}

/** Revalidate a disk occurrence against the open draft, including reference definitions. */
export function locateCitation(
  link: FolderReference,
  draft: string,
): DocumentReference | undefined {
  if (draft === link.sourceText) return link;
  const spelling = link.sourceText.slice(link.from, link.to);
  function occurrences(source: string) {
    return documentReferences(source, link.dialect).filter(
      (ref) =>
        source.slice(ref.from, ref.to) === spelling &&
        ref.target.path === link.target.path &&
        ref.target.fragment === link.target.fragment &&
        ref.target.wikilink === link.target.wikilink,
    );
  }
  const matches = occurrences(draft);
  if (!matches.length) return;
  const sameContext = (ref: DocumentReference) =>
    ref.context === link.context && ref.column === link.column;
  const original = occurrences(link.sourceText);
  if (original.length === 1 && matches.length === 1) return matches[0];
  const contextual = matches.filter(sameContext);
  if (contextual.length === 1 && original.filter(sameContext).length === 1) return contextual[0];
  // Repeated identical lines can still be located if the text up to the occurrence,
  // or from the occurrence to the end, stayed byte-for-byte the same.
  if (original.length !== matches.length) return;
  const fromStart = draft.startsWith(link.sourceText.slice(0, link.to)) ? link.from : -1;
  const endOffset = link.to + draft.length - link.sourceText.length;
  const toEnd = draft.endsWith(link.sourceText.slice(link.from)) ? endOffset : -1;
  const anchored = matches.filter((ref) => ref.from === fromStart || ref.to === toEnd);
  return anchored.length === 1 ? anchored[0] : undefined;
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
      if (targets.has(targetPath))
        results.push({ ...ref, sourcePath, targetPath, sourceText: source, dialect });
    }
  }
  return results;
}
