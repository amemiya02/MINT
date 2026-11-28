import { type DocumentReference, documentReferences, type EditorDialect } from "@mint/editor";
import type { Translate } from "../i18n/index.ts";
import {
  baseName,
  documentExtensions,
  isAbsolutePath,
  isDocumentPath,
  parentPath,
  relativePath,
  resolveFrom,
} from "../paths.ts";
import type { DocumentEdit, Platform } from "../platform/platform.ts";
import { indexWikilinks } from "./wikilinks.ts";

interface TargetOption {
  path: string;
  /** Exact source to substitute, or null when the original still resolves. */
  replacement: string | null;
  unavailable?: boolean;
}

interface MoveReference {
  ref: DocumentReference;
  start: number;
  end: number;
  options: TargetOption[];
}

export interface MovePreview {
  root: string;
  dialect: EditorDialect;
  moveOnly: DocumentEdit;
  documents: { path: string; before: string; references: MoveReference[] }[];
}

function standardReference(
  before: string,
  ref: DocumentReference,
  path: string,
  newSource: string,
  from: string,
  to: string,
): MoveReference | undefined {
  const oldTarget = resolveFrom(path, ref.target.path);
  const newTarget = oldTarget === from ? to : oldTarget;
  if (resolveFrom(newSource, ref.target.path) === newTarget) return;
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
  return {
    ref,
    start: ref.destinationFrom,
    end: ref.destinationTo,
    options: [{ path: oldTarget, replacement: angle ? `<${href}>` : href }],
  };
}

/** Prefer a folder-qualified path. A directory name may contain wikilink syntax,
 * so also try spellings which omit it, using the same resolver as navigation. */
function wikilinkPath(
  root: string,
  source: string,
  target: string,
  resolve: ReturnType<typeof indexWikilinks>,
) {
  const rooted = relativePath(root, target);
  const relative = relativePath(parentPath(source), target);
  const spellings = [
    rooted.includes("/") && rooted === rooted.trimStart() ? rooted : `/${rooted}`,
    baseName(target),
    relative.startsWith("../") ? relative : `./${relative}`,
  ];
  return spellings.find((name) => {
    if (/[#|[\]\r\n]/.test(name)) return false;
    const matches = resolve(source, name.trim());
    return matches.length === 1 && matches[0] === target;
  });
}

function wikiReference(
  before: string,
  ref: DocumentReference,
  root: string,
  newSource: string,
  from: string,
  to: string,
  candidates: readonly string[],
  resolveAfter: ReturnType<typeof indexWikilinks>,
): MoveReference | undefined {
  if (!candidates.length) return;
  const after = resolveAfter(newSource, ref.target.path);
  if (
    !candidates.includes(from) &&
    candidates.length === after.length &&
    candidates.every((p) => after.includes(p))
  )
    return;
  const raw = before.slice(ref.destinationFrom, ref.destinationTo);
  const tail = before.slice(ref.destinationTo, ref.to);
  const options = candidates.map((path): TargetOption => {
    const target = path === from ? to : path;
    if (after.length === 1 && after[0] === target) return { path, replacement: null };
    const qualified = wikilinkPath(root, newSource, target, resolveAfter);
    if (!qualified) return { path, replacement: null, unavailable: true };
    const hash = raw.indexOf("#");
    const pathPart = hash < 0 ? raw : raw.slice(0, hash);
    const destination =
      pathPart.replace(ref.target.path, () => qualified) + (hash < 0 ? "" : raw.slice(hash));
    // Without an explicit alias, the original target (including its anchor) was the visible label.
    const alias = tail === "]]" || tail === "|]]" ? `|${raw}]]` : tail;
    return { path, replacement: `[[${destination}${alias}` };
  });
  if (options.length === 1 && !options[0]?.replacement && !options[0]?.unavailable) return;
  return { ref, start: ref.from, end: ref.to, options };
}

export async function previewMove(
  platform: Platform,
  root: string,
  from: string,
  to: string,
  dialect: EditorDialect,
): Promise<MovePreview> {
  const paths = new Set([from, ...(await platform.listFolderFiles(root, documentExtensions))]);
  const wiki = dialect.wikilinks
    ? {
        before: indexWikilinks(root, [...paths]),
        after: indexWikilinks(
          root,
          [...paths].map((path) => (path === from ? to : path)).filter(isDocumentPath),
        ),
      }
    : null;
  const documents: MovePreview["documents"] = [];
  let movedText = "";
  for (const path of paths) {
    let before: string;
    try {
      before = await platform.readTextFile(path);
    } catch (error) {
      throw new Error(`${path}: ${error}`);
    }
    if (path === from) movedText = before;
    const newSource = path === from ? to : path;
    const references: MoveReference[] = [];
    for (const ref of documentReferences(before, dialect)) {
      if (!ref.target.path) continue;
      const reference = ref.target.wikilink
        ? wiki &&
          wikiReference(
            before,
            ref,
            root,
            newSource,
            from,
            to,
            wiki.before(path, ref.target.path),
            wiki.after,
          )
        : standardReference(before, ref, path, newSource, from, to);
      if (reference) references.push(reference);
    }
    if (references.length) documents.push({ path, before, references });
  }
  return { root, dialect, moveOnly: { from, to, before: movedText, after: movedText }, documents };
}

/** A newly discovered reference or a changed set of wiki choices invalidates confirmation. */
export async function validateMovePreview(platform: Platform, preview: MovePreview, t: Translate) {
  const {
    root,
    dialect,
    moveOnly: { from, to },
  } = preview;
  const current = await previewMove(platform, root, from, to, dialect);
  const previous = new Map(preview.documents.map((doc) => [doc.path, doc]));
  for (const doc of current.documents) {
    const seen = previous.get(doc.path);
    if (
      !seen ||
      seen.before !== doc.before ||
      JSON.stringify(seen.references) !== JSON.stringify(doc.references)
    ) {
      throw new Error(t("move.changed", { path: doc.path }));
    }
    previous.delete(doc.path);
  }
  const removed = previous.keys().next().value;
  if (removed !== undefined) throw new Error(t("move.changed", { path: removed }));
}

export type TargetChoices = ReadonlyMap<DocumentReference, string>;

export function selectedOption(reference: MoveReference, choices: TargetChoices) {
  return reference.options.length === 1
    ? reference.options[0]
    : reference.options.find((option) => option.path === choices.get(reference.ref));
}

export function moveEdits(preview: MovePreview, choices: TargetChoices): DocumentEdit[] {
  const move = { ...preview.moveOnly };
  const edits = [move];
  for (const { path, before, references } of preview.documents) {
    // Reference-style Markdown links can share a definition. Replace its destination only once.
    const replacements = new Map<number, { end: number; text: string }>();
    for (const reference of references) {
      const option = selectedOption(reference, choices);
      if (!option || option.unavailable) throw new Error("Unresolved wikilink target");
      if (option.replacement !== null)
        replacements.set(reference.start, { end: reference.end, text: option.replacement });
    }
    let after = before;
    for (const [start, change] of [...replacements].sort(([a], [b]) => b - a))
      after = after.slice(0, start) + change.text + after.slice(change.end);
    if (path === move.from) move.after = after;
    else if (after !== before) edits.push({ from: path, to: path, before, after });
  }
  return edits;
}

export function inverse(edits: DocumentEdit[]) {
  return edits
    .toReversed()
    .map(({ from, to, before, after }) => ({ from: to, to: from, before: after, after: before }));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function applyMove(
  platform: Platform,
  edits: DocumentEdit[],
  dirty: (path: string) => boolean,
  t: Translate,
) {
  async function apply(edit: DocumentEdit) {
    try {
      await platform.applyDocumentEdit(edit);
    } catch (error) {
      const paths = edit.from === edit.to ? edit.from : `${edit.from} → ${edit.to}`;
      throw new Error(`${paths}: ${errorMessage(error)}`);
    }
  }
  const applied: DocumentEdit[] = [];
  try {
    for (const edit of edits) {
      if (dirty(edit.from) && edit.before !== edit.after)
        throw new Error(t("move.dirty", { path: edit.from }));
      await apply(edit);
      applied.push(edit);
    }
  } catch (error) {
    const failures = [errorMessage(error)];
    for (const edit of inverse(applied)) {
      try {
        await apply(edit);
      } catch (rollbackError) {
        failures.push(errorMessage(rollbackError));
      }
    }
    throw new Error(failures.join("\n"));
  }
}
