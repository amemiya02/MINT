import type { HostAdapter, ImageFile } from "@mint/editor";
import type { Platform } from "../platform/platform.ts";
import { resolveFrom } from "../tabs/paths.ts";
import { joinPath, parentPath } from "../workspace/paths.ts";

/** The part of the editor's host adapter that deals with images. */
export type ImageHost = Required<Pick<HostAdapter, "resolveImageUrl" | "saveImage">>;

/**
 * The asset folder of a document: where pasted and dropped images are saved.
 * For now always `assets/` next to the document.
 */
export function assetFolderFor(documentPath: string): string {
  return joinPath(parentPath(documentPath), "assets");
}

/**
 * Images for the document at `documentPath()` (read on every call, so a
 * renamed document keeps working): local paths resolve against the
 * document's folder, and saved images go to its asset folder.
 */
export function createImageHost(platform: Platform, documentPath: () => string): ImageHost {
  return {
    resolveImageUrl(path) {
      const local = fileUrlPath(path) ?? path;
      return platform.assetUrl(resolveFrom(documentPath(), local));
    },
    async saveImage(file) {
      const document = documentPath();
      const saved = await platform.saveAsset(assetFolderFor(document), assetName(file), file.data);
      return relativePath(parentPath(document), saved);
    },
  };
}

/** The path of a `file:` URL, or `null` for anything else. */
function fileUrlPath(path: string): string | null {
  if (!/^file:/i.test(path)) return null;
  const local = path.replace(/^file:(\/\/[^/]*)?/i, "");
  // `file:///C:/x.png` names `C:/x.png`.
  return /^\/[a-z]:\//i.test(local) ? local.slice(1) : local;
}

const extensions: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/**
 * The file name to save an image under. A dropped file keeps its name; a
 * pasted image (a screenshot, whose clipboard name is meaningless) is named
 * after the time it was pasted. The platform adds `-1`, `-2`... if the name
 * is taken.
 */
function assetName(file: ImageFile): string {
  const name = file.name.replace(/[\\/:*?"<>|\0]/g, "-").trim();
  if (file.origin === "drop" && name !== "" && !name.startsWith(".")) return name;
  const extension =
    extensions[file.type] ?? (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "png");
  return `image-${timestamp(new Date())}.${extension}`;
}

function timestamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-` +
    `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
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
