import { isCommandId } from "../commands.ts";
import type { Translate } from "../i18n/index.ts";
import { isAccelerator } from "../keys.ts";
import type { SettingDefinition } from "./schema.ts";

type Kind = SettingDefinition["kind"];
type DefinitionOf<K extends Kind> = Extract<SettingDefinition, { readonly kind: K }>;

/** What MINT knows about one kind of setting, apart from its control in the settings window. */
interface KindRules<K extends Kind> {
  /** Whether `value` from settings.json is allowed for the setting. */
  isValid(definition: DefinitionOf<K>, value: unknown): boolean;
  /** What a valid value looks like, for the notice about an invalid one. */
  expected(definition: DefinitionOf<K>, t: Translate): string;
}

/**
 * Every kind of setting, in one place. The table is exhaustive, so a new kind
 * fails type checking until it says how to validate and describe its values.
 * (Its control in the settings window is the matching case in `SettingsDialog.tsx`.)
 */
const kinds: { readonly [K in Kind]: KindRules<K> } = {
  choice: {
    isValid: (definition, value) => definition.options.some((option) => option.value === value),
    expected: (definition, t) =>
      t("settings.expected.oneOf", {
        values: definition.options.map((o) => JSON.stringify(o.value)).join(", "),
      }),
  },
  folderToggle: {
    isValid: (_definition, value) =>
      Array.isArray(value) && value.every((path) => typeof path === "string"),
    expected: (_definition, t) => t("settings.expected.folders"),
  },
  toggle: {
    isValid: (_definition, value) => typeof value === "boolean",
    expected: (_definition, t) => t("settings.expected.toggle"),
  },
  number: {
    isValid: (definition, value) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= definition.min &&
      value <= definition.max,
    expected: (definition, t) =>
      t("settings.expected.number", { min: String(definition.min), max: String(definition.max) }),
  },
  text: {
    isValid: (definition, value) =>
      typeof value === "string" && value.length <= definition.maxLength,
    expected: (definition, t) => t("settings.expected.text", { max: String(definition.maxLength) }),
  },
  shortcuts: {
    isValid: (_definition, value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([id, accelerator]) =>
          isCommandId(id) &&
          (accelerator === null || (typeof accelerator === "string" && isAccelerator(accelerator))),
      ),
    expected: (_definition, t) => t("settings.expected.shortcuts"),
  },
};

/** The rules of a setting's kind. */
export function rulesOf(definition: SettingDefinition): KindRules<Kind> {
  // The table pairs each kind with its own rules; TypeScript cannot follow that through the union.
  return kinds[definition.kind] as unknown as KindRules<Kind>;
}
