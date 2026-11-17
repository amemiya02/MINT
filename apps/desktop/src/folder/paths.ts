/**
 * Path helpers for the shell. Paths come from the platform as absolute paths
 * using the platform's separator (`/`, or `\` on Windows); these helpers keep
 * whichever separator a path already uses.
 */

import { baseName } from "../tabs/paths.ts";

export { baseName, isWithin, rebasePath } from "../tabs/paths.ts";

const markdownExtensions = ["md", "markdown"] as const;

/** File extensions treated as documents (open dialog filter, file tree highlighting). */
export const documentExtensions: readonly string[] = markdownExtensions;

export function parentPath(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? path.slice(0, cut + 1) : path.slice(0, cut);
}

export function joinPath(dir: string, name: string): string {
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(separator) ? dir + name : dir + separator + name;
}

export function isDocumentPath(path: string): boolean {
  const name = baseName(path).toLowerCase();
  return documentExtensions.some((ext) => name.endsWith(`.${ext}`));
}

/** Dotfiles and dot-directories (`.git`, `.DS_Store`) are not shown in the file tree. */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/** A name the user typed for a new or renamed entry is a single path segment. */
export function isValidName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\/]/.test(name);
}
