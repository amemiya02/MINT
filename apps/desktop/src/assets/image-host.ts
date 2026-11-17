import type { HostAdapter, ImageFile } from "@mint/editor";
import type { Platform } from "../platform/platform.ts";
import type { Settings } from "../settings/schema.ts";
import { baseName, resolveFrom } from "../tabs/paths.ts";
import { joinPath, parentPath } from "../workspace/paths.ts";

/** The part of the editor's host adapter that deals with images. */
export type ImageHost = Required<Pick<HostAdapter, "resolveImageUrl" | "saveImage">>;

/** Where pasted and dropped images go: the `assetFolder` and `assetFolderPath` settings. */
export type AssetFolderPolicy = Pick<Settings, "assetFolder" | "assetFolderPath">;

/**
 * The asset folder of a document: where pasted and dropped images are saved.
 * - `document`: the document's own folder;
 * - `assets`: `assets/` next to the document;
 * - `documentName`: `<document name>.assets/` next to the document (`notes.md` → `notes.assets/`);
 * - `custom`: `assetFolderPath`, relative to the document's folder or absolute
 *   (empty means the document's folder).
 */
export function assetFolderFor(documentPath: string, policy: AssetFolderPolicy): string {
  const folder = parentPath(documentPath);
  switch (policy.assetFolder) {
    case "document":
      return folder;
    case "assets":
      return joinPath(folder, "assets");
    case "documentName": {
      const name = baseName(documentPath);
      const dot = name.lastIndexOf(".");
      return joinPath(folder, `${dot > 0 ? name.slice(0, dot) : name}.assets`);
    }
    case "custom": {
      const path = policy.assetFolderPath.trim();
      const resolved = resolveFrom(documentPath, path === "" ? "." : path);
      // Absolute paths come back as written: drop a trailing separator, but keep a bare root.
      return /^([a-z]:)?[\\/]$/i.test(resolved) ? resolved : resolved.replace(/[\\/]+$/, "");
    }
  }
}

/** An image that could not be saved, for the host to tell the user about. */
export interface ImageSaveFailure {
  /** The image's file name as pasted or dropped. */
  readonly name: string;
  /** The asset folder it was to be saved in. */
  readonly folder: string;
  readonly reason: string;
}

/**
 * Images for the document at `documentPath()` (read on every call, so a
 * renamed document keeps working): local paths resolve against the
 * document's folder, and saved images go to its asset folder as `policy()`
 * says at the time of saving. A failed save is passed to `onSaveFailed`, and
 * the editor skips that image.
 */
export function createImageHost(
  platform: Platform,
  documentPath: () => string,
  policy: () => AssetFolderPolicy,
  onSaveFailed: (failure: ImageSaveFailure) => void,
): ImageHost {
  return {
    resolveImageUrl(path) {
      const local = fileUrlPath(path) ?? path;
      return platform.assetUrl(resolveFrom(documentPath(), local));
    },
    async saveImage(file) {
      const document = documentPath();
      const folder = assetFolderFor(document, policy());
      try {
        const saved = await platform.saveAsset(folder, assetName(file), file.data);
        return relativePath(parentPath(document), saved);
      } catch (e) {
        onSaveFailed({
          name: file.name,
          folder,
          reason: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
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
