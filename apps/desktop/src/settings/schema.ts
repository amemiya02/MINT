import type { MessageKey } from "../i18n/index.ts";

/**
 * Every setting MINT has. This table is the single source of truth: the
 * `Settings` type, the defaults, the validation of settings.json and the
 * controls in the settings window are all derived from it.
 *
 * To add a setting:
 *   1. Add an entry below with `choice(…)`, `toggle(…)`, `number(…)` or `text(…)`; its key
 *      is the key in settings.json and `default` is used when the key is absent.
 *   2. Add its `label` (and option labels) to `i18n/en.ts` and `i18n/zh-CN.ts`.
 *   3. Read it where it takes effect with `useSettings().settings.<key>`.
 * The settings window shows it automatically, in table order.
 */
export const settingsSchema = {
  language: choice({
    label: "settings.language",
    default: "system",
    options: [
      { value: "system", label: "settings.language.system" },
      { value: "zh-CN", label: "settings.language.zh-CN" },
      { value: "en", label: "settings.language.en" },
    ],
  }),
  autosave: toggle({
    label: "settings.autosave",
    default: true,
  }),
  checkForUpdates: toggle({ label: "settings.checkForUpdates", default: true }),
  appearance: choice({
    label: "settings.appearance",
    default: "system",
    options: [
      { value: "system", label: "settings.appearance.system" },
      { value: "light", label: "settings.appearance.light" },
      { value: "dark", label: "settings.appearance.dark" },
    ],
  }),
  /** A user theme: the name of a `.css` file in the theme folder, without `.css`. Empty for the built-in theme. */
  theme: text({ label: "settings.theme", default: "", maxLength: 200, optionsFrom: "themes" }),
  /** CSS font-family for the document text. Empty for the theme's font. */
  fontFamily: text({
    label: "settings.fontFamily",
    default: "",
    maxLength: 500,
    placeholder: "settings.fontFamily.placeholder",
  }),
  /** In CSS pixels. */
  fontSize: number({ label: "settings.fontSize", default: 15, min: 10, max: 40 }),
  lineHeight: number({ label: "settings.lineHeight", default: 1.7, min: 1, max: 3, step: 0.1 }),
  /** Maximum width of the document text, in CSS pixels. */
  contentWidth: number({
    label: "settings.contentWidth",
    default: 740,
    min: 320,
    max: 2400,
    step: 20,
  }),
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof settingsSchema;

/** The effective value of every setting. */
export type Settings = {
  readonly [K in SettingKey]: ValueOf<(typeof settingsSchema)[K]>;
};

// --- Setting kinds. Each kind has one validator (settings.ts) and one control (SettingsDialog.tsx).

interface BaseSetting<T> {
  /** Label of the control in the settings window. */
  readonly label: MessageKey;
  readonly default: T;
}

/** One of a fixed list of strings; shown as a drop-down. */
export interface ChoiceSetting<T extends string = string> extends BaseSetting<T> {
  readonly kind: "choice";
  readonly options: readonly { readonly value: T; readonly label: MessageKey }[];
}

/** On or off; shown as a checkbox. */
export interface ToggleSetting extends BaseSetting<boolean> {
  readonly kind: "toggle";
}

/** A number within `min`–`max`; shown as a number field. */
export interface NumberSetting extends BaseSetting<number> {
  readonly kind: "number";
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

/**
 * Free text up to `maxLength` characters; shown as a text field, or as a drop-down
 * of values known only at run time when `optionsFrom` names their source.
 */
export interface TextSetting extends BaseSetting<string> {
  readonly kind: "text";
  readonly maxLength: number;
  /** Shown in the empty field. */
  readonly placeholder?: MessageKey;
  /** `themes`: the user themes in the theme folder, plus the built-in theme as `""`. */
  readonly optionsFrom?: "themes";
}

export type SettingDefinition = ChoiceSetting | ToggleSetting | NumberSetting | TextSetting;

type ValueOf<D> = D extends BaseSetting<infer T> ? T : never;

function choice<const T extends string>(
  definition: Omit<ChoiceSetting<T>, "kind" | "default"> & { readonly default: NoInfer<T> },
): ChoiceSetting<T> {
  return { kind: "choice", ...definition };
}

function toggle(definition: Omit<ToggleSetting, "kind">): ToggleSetting {
  return { kind: "toggle", ...definition };
}

function number(definition: Omit<NumberSetting, "kind">): NumberSetting {
  return { kind: "number", ...definition };
}

function text(definition: Omit<TextSetting, "kind">): TextSetting {
  return { kind: "text", ...definition };
}
