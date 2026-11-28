import type { Translate } from "../i18n/index.ts";
import type { SavedWritingSkill } from "./saved-writing-skills.ts";

const skillIds = ["copyedit", "clarify"] as const;
export type WritingSkillId = (typeof skillIds)[number];

export const writingActions = ["comment", "preview", "direct"] as const;
export type WritingAction = (typeof writingActions)[number];

export function readWritingSkill(
  instruction: string,
  saved: readonly SavedWritingSkill[] = [],
  includeBuiltIns = true,
) {
  const text = instruction.trim();
  const [command = "", ...rest] = text.split(/\s+/);
  const builtIns = includeBuiltIns ? skillIds : [];
  const builtin = builtIns.find((id) => command === `/${id}`);
  const custom = saved.find(({ id }) => command === `/${id}`);
  const id = builtin ?? custom?.id;
  if (id) return { id, builtin, custom, instruction: text.slice(id.length + 1).trim() };
  const suggestions =
    rest.length || !command.startsWith("/")
      ? []
      : [...builtIns, ...saved.map(({ id }) => id)].filter((id) => `/${id}`.startsWith(command));
  return { suggestions };
}

export function writingSkillName(t: Translate, id: string, saved: readonly SavedWritingSkill[]) {
  const builtin = skillIds.find((candidate) => candidate === id);
  return builtin
    ? t(`writing.skill.${builtin}`)
    : (saved.find((skill) => skill.id === id)?.name ?? id);
}

export function writingSkillSteps(t: Translate, id: WritingSkillId) {
  return [t(`writing.skill.${id}.step1`), t(`writing.skill.${id}.step2`)];
}

export function writingSkillResult(t: Translate, action: WritingAction) {
  return t(action === "comment" ? "writing.skill.comments" : "writing.skill.edits");
}

export function writingSkillInstruction(
  t: Translate,
  skill: { id: WritingSkillId; instruction: string },
  action: WritingAction,
) {
  return [
    ...writingSkillSteps(t, skill.id),
    t("writing.skill.preserve"),
    skill.instruction && t("writing.skill.authorInstruction", { instruction: skill.instruction }),
    writingSkillResult(t, action),
  ]
    .filter(Boolean)
    .join("\n");
}
