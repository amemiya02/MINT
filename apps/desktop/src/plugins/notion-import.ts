import { defaultDialect, headingAnchors, htmlToMarkdown } from "@mint/markdown";
import { unzipSync } from "fflate";
import type { Translate } from "../i18n/index.ts";
import { baseName, joinPath, parentPath } from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import { canImportArchive } from "./host.ts";
import { archiveLinks } from "./notion-links.ts";

function validSegment(segment: string) {
  return (
    !!segment &&
    segment !== "." &&
    segment !== ".." &&
    !/^\.git$/i.test(segment) &&
    !/[. ]$/.test(segment) &&
    !/[<>:"/\\|?*]/.test(segment) &&
    !Array.from(segment).some((c) => c.charCodeAt(0) < 32) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  );
}

async function readExport(file: File, t: Translate) {
  const limit = 256 * 1024 * 1024;
  if (file.size > limit) throw new Error(t("notion.large"));
  let total = 0;
  let count = 0;
  function unpack(bytes: Uint8Array) {
    const paths = new Set<string>();
    return unzipSync(bytes, {
      filter(entry) {
        total += entry.originalSize;
        if (++count > 20000 || total > limit) throw new Error(t("notion.large"));
        if (entry.name.startsWith("__MACOSX/") || baseName(entry.name) === ".DS_Store")
          return false;
        const path = entry.name.replace(/\/$/, "");
        if (!path.split("/").every(validSegment) || path === "__proto__" || paths.has(path))
          throw new Error(t("notion.invalid", { path }));
        paths.add(path);
        return !entry.name.endsWith("/");
      },
    });
  }
  const outer = unpack(new Uint8Array(await file.arrayBuffer()));
  const entries = Object.entries(outer);
  if (!entries.length || !entries.every(([path]) => /(?:^|[-_ ])Part[-_ ]?\d+\.zip$/i.test(path)))
    return outer;
  const merged: Record<string, Uint8Array> = Object.create(null);
  for (const [, part] of entries) {
    for (const [path, data] of Object.entries(unpack(part))) {
      if (path in merged) throw new Error(t("notion.invalid", { path }));
      merged[path] = data;
    }
  }
  return merged;
}

/** Only this host operation receives the selected File and destination grant. */
export async function importNotion(
  platform: Platform,
  id: string,
  file: File,
  parent: string,
  name: string,
  t: Translate,
) {
  const checkGrant = () => {
    if (!canImportArchive(id)) throw new Error(t("notion.denied"));
  };
  checkGrant();
  if (name.startsWith(".") || !validSegment(name))
    throw new Error(t("notion.invalid", { path: name }));
  const raw = await readExport(file, t);
  checkGrant();
  const pages = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();
  const outputs = new Map<string, string>();
  const used = new Set<string>();
  const issues = new Set<string>();
  for (const path of Object.keys(raw)) {
    const output = path.replace(/\.html?$/i, ".md");
    const key = output.normalize("NFC").toLowerCase();
    if (used.has(key)) throw new Error(t("notion.invalid", { path: output }));
    used.add(key);
    outputs.set(path, output);
  }
  const aliases = new Map<string, Map<string, string>>();
  for (const [path, bytes] of Object.entries(raw)) {
    const output = outputs.get(path) ?? path;
    if (/\.(md|markdown)$/i.test(output)) {
      const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (path === output) {
        pages.set(output, source);
      } else {
        // A template is inert: inspecting the HTML never loads a linked resource.
        const template = document.createElement("template");
        template.innerHTML = source;
        const article = template.content.querySelector("article");
        const anchors = new Map<string, string>();
        const slug = headingAnchors();
        for (const heading of (article ?? template.content).querySelectorAll("h1,h2,h3,h4,h5,h6")) {
          const { id } = slug((heading.textContent ?? "").replace(/\s+/g, " ").trim());
          if (heading.id) anchors.set(heading.id, id);
        }
        aliases.set(output, anchors);
        pages.set(output, htmlToMarkdown(article?.outerHTML ?? source, defaultDialect));
      }
    } else assets.set(path, bytes);
  }
  if (!pages.size) throw new Error(t("notion.empty"));
  const convertLinks = archiveLinks(outputs, pages, aliases, issues, t);
  for (const [source, output] of outputs) {
    const page = pages.get(output);
    if (page !== undefined) pages.set(output, convertLinks(source, page));
  }
  let report = "Import report.txt";
  if (issues.size) {
    for (let n = 2; used.has(report.toLowerCase()); n++) report = `Import report (${n}).txt`;
    pages.set(report, `${[...issues].join("\n")}\n`);
  }

  const stage = joinPath(parent, `.mint-import-${crypto.randomUUID()}`);
  const destination = joinPath(parent, name);
  const directories = new Set<string>([stage]);
  async function prepareFile(path: string) {
    let dir = stage;
    for (const part of path.split("/").slice(0, -1)) {
      dir = joinPath(dir, part);
      if (!directories.has(dir)) {
        checkGrant();
        await platform.createDirectory(dir);
        directories.add(dir);
      }
    }
    return joinPath(dir, baseName(path));
  }

  checkGrant();
  await platform.createDirectory(stage);
  try {
    for (const [path, text] of pages) {
      const target = await prepareFile(path);
      checkGrant();
      await platform.createFile(target);
      checkGrant();
      await platform.writeTextFile(target, text);
    }
    for (const [path, bytes] of assets) {
      const target = await prepareFile(path);
      checkGrant();
      const saved = await platform.saveAsset(parentPath(target), baseName(target), bytes);
      if (saved !== target) throw new Error(t("notion.invalid", { path }));
    }
    checkGrant();
    await platform.rename(stage, destination);
  } catch (error) {
    await platform.moveToTrash(stage);
    throw error;
  }
  return { destination, issues: [...issues], report };
}
