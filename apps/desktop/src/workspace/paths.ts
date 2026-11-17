/**
 * Path helpers for the shell. Paths come from the platform as absolute paths
 * using the platform's separator (`/`, or `\` on Windows); these helpers keep
 * whichever separator a path already uses.
 */

const markdownExtensions = ["md", "markdown"] as const;

/** File extensions treated as documents (open dialog filter, file tree highlighting). */
export const documentExtensions: readonly string[] = markdownExtensions;

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function parentPath(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? path.slice(0, cut + 1) : path.slice(0, cut);
}

export function joinPath(dir: string, name: string): string {
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(separator) ? dir + name : dir + separator + name;
}

/** Whether `path` is `root` itself or inside it. */
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

/** Where `path` ends up after `from` was renamed to `to` (unchanged if not inside `from`). */
export function rebasePath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
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
