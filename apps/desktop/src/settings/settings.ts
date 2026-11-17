import type { Platform, SettingsFile, SettingsValues } from "../platform/platform.ts";
import {
  type SettingDefinition,
  type SettingKey,
  type Settings,
  settingsSchema,
} from "./schema.ts";

/** Something wrong with settings.json that the user should be told about. */
export type SettingsIssue =
  /** The file is not valid JSON (or not an object): every setting keeps its last valid value. */
  | { readonly kind: "unreadable"; readonly reason: string }
  /** One value is not allowed: that setting keeps its last valid value. */
  | { readonly kind: "invalidValue"; readonly key: SettingKey }
  /** A key MINT does not know; it is ignored but kept in the file. */
  | { readonly kind: "unknownKey"; readonly key: string }
  | { readonly kind: "writeFailed"; readonly reason: string };

export interface SettingsState {
  readonly settings: Settings;
  readonly issues: readonly SettingsIssue[];
  /** Absolute path of settings.json. */
  readonly path: string;
}

/**
 * Settings kept in sync with settings.json in both directions: `set` writes the
 * file, and edits made to the file by anyone are applied as they happen.
 */
export interface SettingsStore {
  getSnapshot(): SettingsState;
  subscribe(listener: () => void): () => void;
  set<K extends SettingKey>(key: K, value: Settings[K]): Promise<void>;
}

const keys = Object.keys(settingsSchema) as SettingKey[];

export const defaultSettings = Object.fromEntries(
  keys.map((key) => [key, settingsSchema[key].default]),
) as Settings;

export async function createSettingsStore(platform: Platform): Promise<SettingsStore> {
  const listeners = new Set<() => void>();
  // The last valid file content, so unknown keys survive a write from the settings window.
  let values: SettingsValues = {};
  let state: SettingsState = { settings: defaultSettings, issues: [], path: "" };

  const update = (next: Partial<SettingsState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const apply = (file: SettingsFile) => {
    if (file.status === "invalid") {
      update({ issues: [{ kind: "unreadable", reason: file.message }] });
      return;
    }
    values = file.status === "ok" ? file.values : {};
    update(validate(values, state.settings));
  };

  // Listen before the first read so no change is missed in between.
  platform.onSettingsChanged(apply);
  try {
    const [path, file] = await Promise.all([platform.settingsPath(), platform.readSettings()]);
    state = { ...state, path };
    apply(file);
  } catch (e) {
    // Never keep the app from starting: run on defaults and say why.
    apply({ status: "invalid", message: String(e) });
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async set(key, value) {
      values = { ...values, [key]: value };
      update({
        settings: { ...state.settings, [key]: value },
        issues: state.issues.filter((i) => !("key" in i && i.key === key)),
      });
      try {
        await platform.writeSettings(values);
      } catch (e) {
        update({
          issues: [...state.issues, { kind: "writeFailed", reason: String(e) }],
        });
      }
    },
  };
}

/**
 * Take every valid value from the file, the default for every absent key, and the
 * previous value for every invalid one.
 */
function validate(values: SettingsValues, previous: Settings) {
  const settings: Record<string, unknown> = {};
  const issues: SettingsIssue[] = [];
  for (const key of keys) {
    if (!(key in values)) {
      settings[key] = settingsSchema[key].default;
    } else if (isValid(settingsSchema[key], values[key])) {
      settings[key] = values[key];
    } else {
      settings[key] = previous[key];
      issues.push({ kind: "invalidValue", key });
    }
  }
  for (const key of Object.keys(values)) {
    if (!(key in settingsSchema)) issues.push({ kind: "unknownKey", key });
  }
  return { settings: settings as Settings, issues };
}

function isValid(definition: SettingDefinition, value: unknown): boolean {
  switch (definition.kind) {
    case "choice":
      return definition.options.some((option) => option.value === value);
    case "toggle":
      return typeof value === "boolean";
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= definition.min &&
        value <= definition.max
      );
  }
}
