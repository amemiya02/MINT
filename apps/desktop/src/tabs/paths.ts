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
