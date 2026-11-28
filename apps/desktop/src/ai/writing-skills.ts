import type { Translate } from "../i18n/index.ts";

const skillIds = ["copyedit", "clarify"] as const;
export type WritingSkillId = (typeof skillIds)[number];

export const writingActions = ["comment", "preview", "direct"] as const;
export type WritingAction = (typeof writingActions)[number];

export function readWritingSkill(instruction: string) {
  const text = instruction.trim();
  const [command = "", ...rest] = text.split(/\s+/);
  const id = skillIds.find((id) => command === `/${id}`);
  if (id) return { id, instruction: text.slice(id.length + 1).trim() };
  const suggestions = rest.length ? [] : skillIds.filter((id) => `/${id}`.startsWith(command));
  return { suggestions: command.startsWith("/") ? suggestions : [] };
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
