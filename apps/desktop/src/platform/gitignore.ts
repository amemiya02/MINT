/**
 * A small `.gitignore` matcher for the in-memory platform, so it lists folder
 * files the way the Rust backend (the `ignore` crate) does. It covers the
 * common syntax: `#` comments, `!` negation, a trailing `/` for directories,
 * a leading or inner `/` to anchor a pattern to its `.gitignore`, and the
 * `*`, `?` and `**` wildcards.
 */

export interface IgnoreFile {
  /** Directory of the `.gitignore`, relative to the folder (`""` for the folder itself). */
  readonly dir: string;
  readonly text: string;
}

interface Rule {
  readonly dir: string;
  readonly negate: boolean;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
}

export interface IgnoreRules {
  /** Whether a file, given relative to the folder with `/` separators, is ignored. */
  isIgnored(relativePath: string): boolean;
}

export function createIgnoreRules(files: readonly IgnoreFile[]): IgnoreRules {
  // Shallower files first, so rules of deeper ones take precedence (the last match wins).
  const ordered = [...files].sort((a, b) => depth(a.dir) - depth(b.dir));
  const rules = ordered.flatMap((file) => parse(file));

  function matches(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const rule of rules) {
      if (rule.dir !== "" && !path.startsWith(`${rule.dir}/`)) continue;
      if (rule.directoryOnly && !isDirectory) continue;
      const relative = rule.dir === "" ? path : path.slice(rule.dir.length + 1);
      if (rule.regex.test(relative)) ignored = !rule.negate;
    }
    return ignored;
  }

  return {
    isIgnored(relativePath) {
      const segments = relativePath.split("/");
      // Nothing inside an ignored directory can be re-included.
      for (let i = 1; i < segments.length; i++) {
        if (matches(segments.slice(0, i).join("/"), true)) return true;
      }
      return matches(relativePath, false);
    },
  };
}

function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

function parse({ dir, text }: IgnoreFile): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let pattern = raw.replace(/(?<!\\)\s+$/, "");
    if (pattern === "" || pattern.startsWith("#")) continue;
    const negate = pattern.startsWith("!");
    if (negate) pattern = pattern.slice(1);
    const directoryOnly = pattern.endsWith("/");
    if (directoryOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern === "") continue;
    const body = globToRegex(pattern);
    rules.push({
      dir,
      negate,
      directoryOnly,
      regex: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
    });
  }
  return rules;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob.charAt(i + 1) === "*") {
      const slash = glob.charAt(i + 2) === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "\\" && i + 1 < glob.length) {
      i++;
      out += escapeChar(glob.charAt(i));
    } else {
      out += escapeChar(c);
    }
  }
  return out;
}

function escapeChar(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
