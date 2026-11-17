import { type Dialect, defaultDialect } from "@mint/markdown";

/** The settings that make up the dialect: the extended syntax switches (see schema.ts). */
export interface DialectSettings {
  readonly extendedToc: boolean;
  readonly extendedHighlight: boolean;
  readonly extendedSuperscript: boolean;
  readonly extendedSubscript: boolean;
}

/**
 * The dialect the settings describe: the default dialect with the extended
 * syntax switches from the settings. Editing and exporting both use it.
 */
export function dialectOf(settings: DialectSettings): Dialect {
  return {
    ...defaultDialect,
    extended: {
      toc: settings.extendedToc,
      highlight: settings.extendedHighlight,
      superscript: settings.extendedSuperscript,
      subscript: settings.extendedSubscript,
    },
  };
}
