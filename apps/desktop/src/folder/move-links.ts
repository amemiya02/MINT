import { documentReferences } from "@mint/editor";
import type { Dialect } from "@mint/markdown";
import {
  documentExtensions,
  isAbsolutePath,
  parentPath,
  relativePath,
  resolveFrom,
} from "../paths.ts";
import type { DocumentEdit, Platform } from "../platform/platform.ts";

export interface MovePreview {
  edits: DocumentEdit[];
  references: {
    path: string;
    line: number;
    column: number;
    context: string;
    destination: string;
  }[];
}

export async function previewMove(
  platform: Platform,
  root: string,
  from: string,
  to: string,
  dialect: Dialect,
): Promise<MovePreview> {
  const edits: DocumentEdit[] = [];
  const references: MovePreview["references"] = [];
  const paths = new Set([from, ...(await platform.listFolderFiles(root, documentExtensions))]);
  for (const path of paths) {
    let before: string;
    try {
      before = await platform.readTextFile(path);
    } catch (error) {
      throw new Error(`${path}: ${error}`);
    }
    const newSource = path === from ? to : path;
    const replacements = new Map<number, { end: number; text: string }>();
    for (const ref of documentReferences(before, dialect)) {
      if (!ref.target.path) continue;
      const oldTarget = resolveFrom(path, ref.target.path);
      const newTarget = oldTarget === from ? to : oldTarget;
      if (resolveFrom(newSource, ref.target.path) === newTarget) continue;
      const raw = before.slice(ref.destinationFrom, ref.destinationTo);
      const angle = raw.startsWith("<") && raw.endsWith(">");
      const url = angle ? raw.slice(1, -1) : raw;
      const suffix = url.match(/[?#][\s\S]*$/)?.[0] ?? "";
      const newPath = isAbsolutePath(ref.target.path)
        ? newTarget
        : relativePath(parentPath(newSource), newTarget);
      const encoded = newPath
        .replaceAll("\\", "/")
        .split("/")
        .map((segment) => encodeURIComponent(segment).replaceAll("(", "%28").replaceAll(")", "%29"))
        .join("/");
      const href = encoded + suffix;
      const destination = angle ? `<${href}>` : href;
      references.push({
        path,
        line: ref.line,
        column: ref.column,
        context: ref.context,
        destination,
      });
      replacements.set(ref.destinationFrom, { end: ref.destinationTo, text: destination });
    }
    let after = before;
    for (const [start, change] of [...replacements].sort(([a], [b]) => b - a)) {
      after = after.slice(0, start) + change.text + after.slice(change.end);
    }
    if (path !== newSource || after !== before)
      edits.push({ from: path, to: newSource, before, after });
  }
  return { edits, references };
}

export function inverse(edits: DocumentEdit[]) {
  return edits
    .toReversed()
    .map(({ from, to, before, after }) => ({ from: to, to: from, before: after, after: before }));
}

export async function applyMove(
  platform: Platform,
  edits: DocumentEdit[],
  dirty: (path: string) => boolean,
) {
  async function apply(edit: DocumentEdit) {
    try {
      await platform.applyDocumentEdit(edit);
    } catch (error) {
      const paths = edit.from === edit.to ? edit.from : `${edit.from} → ${edit.to}`;
      throw new Error(`${paths}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const applied: DocumentEdit[] = [];
  try {
    for (const edit of edits) {
      if (dirty(edit.from) && edit.before !== edit.after)
        throw new Error(`${edit.from}: unsaved changes`);
      await apply(edit);
      applied.push(edit);
    }
  } catch (error) {
    const failures = [String(error)];
    for (const edit of inverse(applied)) {
      try {
        await apply(edit);
      } catch (rollbackError) {
        failures.push(String(rollbackError));
      }
    }
    throw new Error(failures.join("\n"));
  }
}
