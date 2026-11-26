/**
 * Path helpers for the shell, in one place. Paths come from the platform as
 * absolute paths using the platform's separator (`/`, or `\` on Windows);
 * these helpers accept either and keep whichever a path already uses.
 */

/** The separator a path uses: `\` for a Windows path without any `/`, else `/`. */
export function separatorOf(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Index of the last separator (`/` or `\`) in `path`, or -1. The file name starts after it. */
export function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/** The file name part of a path, for tab labels and window titles. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Whether `path` is `root` itself or inside it. */
export function isWithin(path: string, root: string): boolean {
  if (path === root) return true;
  if (/[\\/]$/.test(root)) return path.startsWith(root);
  return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

/** Where `path` ends up after `from` was renamed to `to` (unchanged if not inside `from`). */
export function rebasePath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}

/** Whether `path` is absolute: `/…`, `C:\…` or `C:/…`, or a `\\server\share` path. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
}

/**
 * Resolve `target` (a path as written in a Markdown link) against the
 * document at `from`. Absolute targets are returned as they are; relative
 * ones are joined to the document's folder with `.` and `..` resolved, using
 * the separator of `from`.
 */
export function resolveFrom(from: string, target: string): string {
  if (isAbsolutePath(target)) return target;
  const separator = separatorOf(from);
  const base = from.split(/[\\/]/).slice(0, -1);
  const root = base[0] ?? "";
  const parts = base.slice(1);
  for (const segment of target.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return [root, ...parts].join(separator);
}

/**
 * `to` relative to the directory `from`, `/`-separated (as Markdown wants,
 * on every platform). Falls back to `to` itself when they share no root,
 * such as two Windows drives.
 */
export function relativePath(from: string, to: string): string {
  const split = (p: string) => p.split(/[\\/]/).filter((s, i) => s !== "" || i === 0);
  const base = split(from);
  const target = split(to);
  const sameRoot = (base[0] ?? "").toLowerCase() === (target[0] ?? "").toLowerCase();
  if (!sameRoot) return to;
  let common = 0;
  while (common < base.length && common < target.length && base[common] === target[common]) {
    common++;
  }
  return [...base.slice(common).map(() => ".."), ...target.slice(common)].join("/");
}

const markdownExtensions = ["md", "markdown"] as const;

/** File extensions treated as documents (open dialog filter, file tree highlighting). */
export const documentExtensions: readonly string[] = markdownExtensions;

/** The folder part of a path (`/a/b.md` → `/a`); the root of a root-level path stays (`/b.md` → `/`). */
export function parentPath(path: string): string {
  const cut = lastSeparator(path);
  // A drive root includes its separator, e.g. the parent of C:\notes is C:\.
  if (cut === 2 && /^[a-z]:/i.test(path)) return path.slice(0, 3);
  return cut <= 0 ? path.slice(0, cut + 1) : path.slice(0, cut);
}

export function joinPath(dir: string, name: string): string {
  const separator = separatorOf(dir);
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
