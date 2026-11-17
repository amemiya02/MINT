/** The file name part of a path, for tab labels and window titles. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
