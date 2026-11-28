import { parser } from "@lezer/markdown";
import { markdownHeadings, matchingHeadings } from "@mint/markdown";
import type { Translate } from "../i18n/index.ts";
import { baseName, parentPath, relativePath } from "../paths.ts";

const pageId = /([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
function idOf(name: string) {
  return name.match(pageId)?.[1]?.replaceAll("-", "").toLowerCase();
}

/** Only resolve targets against archive entries. References never initiate file or network reads. */
export function archiveLinks(
  outputs: Map<string, string>,
  pages: Map<string, string>,
  aliases: Map<string, Map<string, string>>,
  issues: Set<string>,
  t: Translate,
) {
  const byId = new Map<string, string | null>();
  for (const [source, output] of outputs) {
    const id = idOf(baseName(source).replace(/\.[^.]+$/, ""));
    if (id && /\.md$/i.test(output)) byId.set(id, byId.has(id) ? null : source);
  }
  const headings = new Map<string, ReturnType<typeof markdownHeadings>>();
  function resolve(source: string, href: string) {
    const suffix = href.match(/[?#].*$/)?.[0] ?? "";
    let path = href.slice(0, href.length - suffix.length);
    if (/^[\w+.-]+:|^\/\//.test(href)) {
      let url: URL;
      try {
        url = new URL(href, "https://localhost");
      } catch {
        return null;
      }
      if (!/(^|\.)(notion\.so|notion\.site)$/i.test(url.hostname)) return href;
      const id = idOf(url.searchParams.get("p") ?? baseName(url.pathname.replace(/\/$/, "")));
      const original = id && byId.get(id);
      return original ? relative(original, url.hash) : null;
    }
    if (!path) return relative(source, suffix, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      return null;
    }
    const parts = path.startsWith("/") ? [] : source.split("/").slice(0, -1);
    for (const part of path.split("/")) {
      if (part === "." || !part) continue;
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(part);
    }
    const original = parts.join("/");
    const mapped = outputs.get(original);
    if (!mapped) return null;
    return relative(
      original,
      suffix,
      mapped === original && !path.startsWith("/")
        ? href.slice(0, href.length - suffix.length)
        : undefined,
    );

    function relative(original: string, suffix: string, unchanged?: string) {
      const target = outputs.get(original);
      if (!target) return null;
      const hash = suffix.indexOf("#");
      const page = pages.get(target);
      if (hash >= 0 && hash + 1 < suffix.length && page !== undefined) {
        let fragment: string;
        try {
          fragment = decodeURIComponent(suffix.slice(hash + 1));
        } catch {
          return null;
        }
        const mapped = aliases.get(target)?.get(fragment);
        if (mapped) suffix = suffix.slice(0, hash + 1) + encodeURIComponent(mapped);
        else {
          let list = headings.get(target);
          if (!list) {
            list = markdownHeadings(page);
            headings.set(target, list);
          }
          if (matchingHeadings(list, fragment).length !== 1) return null;
        }
      }
      if (unchanged !== undefined) return unchanged + suffix;
      return (
        relativePath(parentPath(`/${source}`), `/${target}`)
          .split("/")
          .map((s) => encodeURIComponent(s).replaceAll("(", "%28").replaceAll(")", "%29"))
          .join("/") + suffix
      );
    }
  }

  return (source: string, text: string) => {
    const edits: { from: number; to: number; insert: string }[] = [];
    let line = 1;
    let previous = 0;
    parser.parse(text).iterate({
      enter(node) {
        if (node.name !== "URL") return;
        const owner = node.node.parent;
        if (!owner) return;
        line += (text.slice(previous, node.from).match(/\r\n|\r|\n/g) ?? []).length;
        previous = node.from;
        const href = text.slice(node.from, node.to).replace(/^<(.*)>$/, "$1");
        const mapped = resolve(source, href);
        if (mapped === null) {
          const asset =
            owner.name === "Image" ||
            /\.(?!html?\b|md\b|markdown\b)[\w]+(?:[?#]|$)/i.test(href.split("/").at(-1) ?? "");
          issues.add(
            `${outputs.get(source)}:${line} — ${t(asset ? "notion.missingAsset" : "notion.missingLink")} — ${href}`,
          );
        } else if (mapped !== href) {
          if (owner.name === "Autolink")
            edits.push({ from: owner.from, to: owner.to, insert: `[${href}](${mapped})` });
          else
            edits.push({
              from: node.from,
              to: node.to,
              insert: text[node.from] === "<" ? `<${mapped}>` : mapped,
            });
        }
      },
    });
    let result = "";
    let pos = 0;
    for (const edit of edits) {
      result += text.slice(pos, edit.from) + edit.insert;
      pos = edit.to;
    }
    return result + text.slice(pos);
  };
}
