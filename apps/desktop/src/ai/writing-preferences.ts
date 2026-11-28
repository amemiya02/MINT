import { isWithin } from "../paths.ts";

export interface WritingPreference {
  readonly topic: string;
  readonly guidance: string;
}

export interface StoredWritingPreference extends WritingPreference {
  readonly key: string;
  readonly folder: string | null;
}

export type WritingPreferenceScope = "task" | "folder" | "personal";

export interface AppliedWritingPreference extends WritingPreference {
  readonly scope: WritingPreferenceScope;
}

export const writingPreferencesFile = "writing-preferences.json";

export function writingPreferenceFolder(folder: string | null, path: string | null) {
  return folder && (path === null || isWithin(path, folder)) ? folder : null;
}

export function preferenceKey(topic: string) {
  return topic.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function readWritingPreferences(json: string | null): StoredWritingPreference[] {
  const preferences: StoredWritingPreference[] = JSON.parse(json ?? "[]");
  if (
    !Array.isArray(preferences) ||
    !preferences.every(
      (item) =>
        item &&
        typeof item.key === "string" &&
        typeof item.topic === "string" &&
        typeof item.guidance === "string" &&
        (item.folder === null || typeof item.folder === "string"),
    )
  ) {
    throw new Error("Invalid writing preferences");
  }
  return preferences;
}

export function resolveWritingPreferences(
  saved: readonly StoredWritingPreference[],
  folder: string | null,
  task: readonly WritingPreference[],
): AppliedWritingPreference[] {
  const applied = new Map<string, AppliedWritingPreference>();
  for (const { key, topic, guidance, folder } of saved) {
    if (folder === null) applied.set(key, { topic, guidance, scope: "personal" });
  }
  if (folder !== null) {
    for (const { key, topic, guidance, folder: savedFolder } of saved) {
      if (folder === savedFolder) applied.set(key, { topic, guidance, scope: "folder" });
    }
  }
  for (const { topic, guidance } of task) {
    applied.set(preferenceKey(topic), { topic, guidance, scope: "task" });
  }
  return [...applied.values()];
}

export function outboundWritingPreferences(preferences?: readonly AppliedWritingPreference[]) {
  return preferences?.map(({ topic, guidance }) => ({ topic, guidance }));
}

export const writingPreferenceInstruction =
  "The preferences in the current request are the author's writing defaults. The explicit current instruction takes precedence over every preference that conflicts with it. Apply preferences only where relevant to the task.";
