import type { DocumentLink } from "@mint/editor";
import type { Translate } from "../i18n/index.ts";
import {
  baseName,
  documentExtensions,
  isDocumentPath,
  relativePath,
  resolveFrom,
} from "../paths.ts";
import type { Platform } from "../platform/platform.ts";

/** Bare names search the folder, qualified names start at its root, and ./ or ../ start at the source. */
export function indexWikilinks(folder: string, paths: readonly string[]) {
  const names = new Map<string, string[]>();
  const qualified = new Map<string, string[]>();
  const key = (name: string) => name.normalize("NFC").toLowerCase();
  function add(index: Map<string, string[]>, name: string, path: string) {
    const nameKey = key(name);
    const matches = index.get(nameKey);
    if (matches) matches.push(path);
    else index.set(nameKey, [path]);
  }
  for (const path of paths) {
    for (const [index, name] of [
      [names, baseName(path)],
      [qualified, relativePath(folder, path)],
    ] as const) {
      add(index, name, path);
      const stem = name.slice(0, name.lastIndexOf("."));
      if (!isDocumentPath(stem)) add(index, stem, path);
    }
  }
  return (source: string, target: string): readonly string[] => {
    if (!target) return [source];
    const name = target.replaceAll("\\", "/");
    if (!name.includes("/")) return names.get(key(name)) ?? [];
    const relative = /^\.\.?\//.test(name)
      ? relativePath(folder, resolveFrom(source, name))
      : name.replace(/^\//, "");
    return qualified.get(key(relative)) ?? [];
  };
}

export async function resolveDocumentLink(
  platform: Platform,
  folder: string | null,
  source: string | null,
  link: DocumentLink,
  t: Translate,
): Promise<{ path: string | null } | { error: string }> {
  if (!link.path) return { path: source };
  if (!link.wikilink) return { path: source ? resolveFrom(source, link.path) : link.path };
  if (!folder || !source) return { error: t("error.missingWikilink", { path: link.path }) };
  try {
    const paths = await platform.listFolderFiles(folder, documentExtensions);
    const matches = indexWikilinks(folder, paths)(source, link.path);
    if (!matches[0]) return { error: t("error.missingWikilink", { path: link.path }) };
    if (matches.length > 1)
      return {
        error: t("error.ambiguousWikilink", {
          path: link.path,
          matches: matches.map((path) => relativePath(folder, path)).join(", "),
        }),
      };
    return { path: matches[0] };
  } catch (error) {
    return { error: t("error.open", { path: link.path, reason: String(error) }) };
  }
}
