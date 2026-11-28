import type { Translate } from "../i18n/index.ts";
import type { Platform } from "../platform/platform.ts";
import type { NamedMaterial, TaskContext } from "./writing-sender.ts";
import {
  readWritingSkill,
  type WritingAction,
  writingSkillResult,
  writingSkillSteps,
} from "./writing-skills.ts";
import type { SavedTurn, WritingToolRecord } from "./writing-tasks.ts";

export type WritingSkillScope = "selection" | "document" | "instruction" | "folder";
export type WritingSkillTool =
  | { readonly kind: "zotero" }
  | {
      readonly kind: "mcp";
      readonly name: string;
      readonly effect: WritingToolRecord["effect"];
    };

const materialKinds = ["text", "pdf", "image"] as const;
type MaterialKind = (typeof materialKinds)[number];

export function writingSkillMaterials(materials: readonly NamedMaterial[] = []): MaterialKind[] {
  return [...new Set(materials.map((material) => material.range?.kind ?? "text"))];
}

function writingSkillContext(context?: TaskContext) {
  return {
    materials: writingSkillMaterials([
      ...(context?.materials ?? []),
      ...(context?.materialDecisions?.flatMap((decision) =>
        decision.outcome === "allowed" ? [decision.material] : [],
      ) ?? []),
    ]),
    includeDraft: context?.currentDraft ? (true as const) : undefined,
    folderSearch: context?.folderSearch,
  };
}

export interface WritingMethod {
  readonly steps?: string;
  readonly result?: string;
  readonly scope: WritingSkillScope;
  readonly action: WritingAction;
  readonly format?: "draft";
  readonly tools: readonly WritingSkillTool[];
  readonly materials?: readonly MaterialKind[];
  readonly includeDraft?: true;
  readonly folderSearch?: true;
}

export interface WritingSkillDraft extends WritingMethod {
  readonly name: string;
  readonly steps: string;
  readonly result: string;
}

export interface SavedWritingSkill extends WritingSkillDraft {
  readonly version: 1;
  readonly id: string;
}

export function makeWritingSkillDraft(
  t: Translate,
  turn: Omit<SavedTurn, "suggestions"> & { readonly suggestions?: readonly unknown[] },
): WritingSkillDraft {
  const first = turn.baseline?.requests[0];
  const action =
    turn.method?.action ??
    (turn.direct ? "direct" : turn.suggestions || turn.folderChanges ? "preview" : "comment");
  const builtin = turn.skillInstruction ? readWritingSkill(turn.instruction) : undefined;
  const steps = builtin?.builtin
    ? [...writingSkillSteps(t, builtin.builtin), t("writing.skill.preserve"), builtin.instruction]
        .filter(Boolean)
        .join("\n")
    : (turn.skillInstruction ?? turn.instruction);
  const format = turn.method?.format;
  const scope =
    turn.method?.scope ??
    turn.baseline?.scope ??
    (first?.selectedText !== undefined || turn.material !== undefined
      ? "selection"
      : turn.context?.currentDraft
        ? "document"
        : "instruction");
  const context = writingSkillContext(turn.context);
  return {
    ...turn.method,
    name: "",
    steps: turn.method?.steps ?? steps,
    result:
      turn.method?.result ??
      (format === "draft" ? t("writing.skill.draftFormat") : writingSkillResult(t, action)),
    scope,
    action,
    format,
    materials: [...new Set([...(turn.method?.materials ?? []), ...context.materials])],
    includeDraft:
      scope === "document" ? undefined : (turn.method?.includeDraft ?? context.includeDraft),
    folderSearch: turn.method?.folderSearch ?? context.folderSearch,
    tools:
      turn.method?.tools ??
      (turn.toolOutcome?.status === "done"
        ? [{ kind: "mcp", name: turn.toolOutcome.name, effect: turn.toolOutcome.effect }]
        : []),
  };
}

export function savedSkillInstruction(
  t: Translate,
  skill: WritingSkillDraft,
  action: WritingAction,
  extra = "",
) {
  return [
    skill.steps,
    t("writing.skill.requestedFormat", { format: skill.result }),
    extra && t("writing.skill.authorInstruction", { instruction: extra }),
    skill.format !== "draft" && writingSkillResult(t, action),
  ]
    .filter(Boolean)
    .join("\n");
}

const library = "writing-skills.json";
const changes = new EventTarget();

export function watchWritingSkills(onChange: () => void) {
  changes.addEventListener("change", onChange);
  window.addEventListener("focus", onChange);
  return () => {
    changes.removeEventListener("change", onChange);
    window.removeEventListener("focus", onChange);
  };
}

export async function readWritingSkills(platform: Platform): Promise<readonly SavedWritingSkill[]> {
  return parseLibrary(await platform.readAppData(library));
}

function parseLibrary(text: string | null): readonly SavedWritingSkill[] {
  if (text === null) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("invalidWritingSkill");
  return value.map((skill: unknown) => {
    if (
      !object(skill) ||
      skill.version !== 1 ||
      typeof skill.id !== "string" ||
      !/^[\p{L}\p{N}][\p{L}\p{N}-]{0,79}$/u.test(skill.id)
    ) {
      throw new Error("invalidWritingSkill");
    }
    return { ...methodFromJSON(skill), version: 1, id: skill.id };
  });
}

export function validWritingSkillDraft(draft: WritingSkillDraft) {
  return (
    !!draft.name.trim() &&
    draft.name.length <= 100 &&
    !!draft.steps.trim() &&
    draft.steps.length <= 12_000 &&
    !!draft.result.trim() &&
    draft.result.length <= 4_000
  );
}

export async function saveWritingSkill(platform: Platform, draft: WritingSkillDraft) {
  const method = methodFromJSON(draft);
  const slug = [
    ...method.name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, ""),
  ]
    .slice(0, 64)
    .join("");
  const base = slug || "skill";
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await platform.readAppData(library);
    const skills = parseLibrary(previous);
    const occupied = new Set(["copyedit", "clarify", ...skills.map(({ id }) => id)]);
    let id = base;
    for (let suffix = 2; occupied.has(id); suffix++) id = `${base}-${suffix}`;
    const skill: SavedWritingSkill = { ...method, version: 1, id };
    if (
      await platform.compareAndWriteAppData(library, previous, JSON.stringify([...skills, skill]))
    ) {
      changes.dispatchEvent(new Event("change"));
      return skill;
    }
  }
  throw new Error("writingSkillsChanged");
}

const packageKind = "mint-writing-skill";
const maxPackageBytes = 128 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolFromJSON(value: unknown): WritingSkillTool {
  if (object(value)) {
    if (value.kind === "zotero") return { kind: "zotero" };
    if (
      value.kind === "mcp" &&
      typeof value.name === "string" &&
      value.name.trim() &&
      value.name.length <= 200 &&
      (value.effect === "read" || value.effect === "modify" || value.effect === "send")
    ) {
      return { kind: "mcp", name: value.name, effect: value.effect };
    }
  }
  throw new Error("invalidWritingSkill");
}

function methodFromJSON(value: unknown): WritingSkillDraft {
  if (!object(value)) throw new Error("invalidWritingSkill");
  const {
    name,
    steps,
    result,
    scope,
    action,
    format,
    tools,
    materials,
    includeDraft,
    folderSearch,
  } = value;
  if (
    typeof name !== "string" ||
    typeof steps !== "string" ||
    typeof result !== "string" ||
    (scope !== "selection" &&
      scope !== "document" &&
      scope !== "instruction" &&
      scope !== "folder") ||
    (action !== "comment" && action !== "preview" && action !== "direct") ||
    (format !== undefined && format !== "draft") ||
    (materials !== undefined &&
      (!Array.isArray(materials) ||
        materials.length > materialKinds.length ||
        materials.some((kind) => !materialKinds.includes(kind)))) ||
    (includeDraft !== undefined && includeDraft !== true) ||
    (folderSearch !== undefined && folderSearch !== true) ||
    !Array.isArray(tools) ||
    tools.length > 8
  ) {
    throw new Error("invalidWritingSkill");
  }
  const draft: WritingSkillDraft = {
    name: name.trim(),
    steps: steps.trim(),
    result: result.trim(),
    scope,
    action,
    format,
    tools: tools.map(toolFromJSON),
    materials,
    includeDraft,
    folderSearch,
  };
  if (!validWritingSkillDraft(draft)) throw new Error("invalidWritingSkill");
  return draft;
}

export async function importWritingSkill(file: File): Promise<WritingSkillDraft> {
  if (file.size > maxPackageBytes) throw new Error("invalidWritingSkill");
  const value: unknown = JSON.parse(await file.text());
  if (!object(value) || value.kind !== packageKind || value.version !== 1)
    throw new Error("invalidWritingSkill");
  return methodFromJSON(value.skill);
}

export async function exportWritingSkill(
  platform: Platform,
  skill: SavedWritingSkill,
  title: string,
  filter: string,
) {
  const packageJSON = JSON.stringify(
    { kind: packageKind, version: 1, skill: methodFromJSON(skill) },
    null,
    2,
  );
  const path = await platform.showSaveDialog({
    title,
    defaultPath: `${skill.id}.mint-skill.json`,
    filters: [{ name: filter, extensions: ["json"] }],
  });
  if (path) await platform.writeTextFile(path, `${packageJSON}\n`);
}
