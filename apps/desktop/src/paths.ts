/**
 * Resolve `target` (a path as written in a Markdown link) against the
 * document at `from`. Absolute targets are returned as they are; relative
 * ones are joined to the document's folder with `.` and `..` resolved, using
 * the separator of `from`.
 */
export function resolveFrom(from: string, target: string): string {
  if (target.startsWith("/") || /^[a-z]:[\\/]/i.test(target) || target.startsWith("\\\\")) {
    return target;
  }
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
