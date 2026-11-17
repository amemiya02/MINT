/** The file name part of a path, for tab labels and window titles. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Whether `path` is `root` itself or inside it. */
export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
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
  const separator = from.includes("\\") && !from.includes("/") ? "\\" : "/";
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
