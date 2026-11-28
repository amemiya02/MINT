import type { HostAdapter, ImageFile } from "@mint/editor";
import {
  baseName,
  isAbsolutePath,
  joinPath,
  parentPath,
  relativePath,
  resolveFrom,
} from "../paths.ts";
import type { Platform } from "../platform/platform.ts";
import type { Settings } from "../settings/schema.ts";

/** The part of the editor's host adapter that deals with images. */
export type ImageHost = Required<Pick<HostAdapter, "resolveImageUrl" | "saveImage">>;

/** Where pasted and dropped images go: the `assetFolder` and `assetFolderPath` settings. */
export type AssetFolderPolicy = Pick<Settings, "assetFolder" | "assetFolderPath">;

/** Resolve a local image through the platform's grants for the document containing it. */
export function documentImageUrl(
  platform: Platform,
  document: string | null,
  path: string,
): string | null {
  const local = fileUrlPath(path) ?? path;
  if (document === null) return isAbsolutePath(local) ? platform.assetUrl(local) : null;
  return platform.assetUrl(resolveFrom(document, local));
}

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
  /** The asset folder it was to be saved in; `null` when the document is untitled and has none yet. */
  readonly folder: string | null;
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
  documentPath: () => string | null,
  policy: () => AssetFolderPolicy,
  onSaveFailed: (failure: ImageSaveFailure) => void,
): ImageHost {
  return {
    resolveImageUrl: (path) => documentImageUrl(platform, documentPath(), path),
    async saveImage(file) {
      const document = documentPath();
      if (document === null) {
        const reason = "an untitled document has no asset folder yet";
        onSaveFailed({ name: file.name, folder: null, reason });
        throw new Error(reason);
      }
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
