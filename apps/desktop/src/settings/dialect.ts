import { type Dialect, defaultDialect } from "@mint/markdown";
import { useMemo } from "react";
import type { Settings } from "./schema.ts";
import { useSettings } from "./useSettings.ts";

type DialectSettings = Pick<
  Settings,
  "extendedToc" | "extendedHighlight" | "extendedSuperscript" | "extendedSubscript"
>;

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

/** The current dialect; a new object only when one of its switches changes. */
export function useDialect(): Dialect {
  const { extendedToc, extendedHighlight, extendedSuperscript, extendedSubscript } =
    useSettings().settings;
  return useMemo(
    () => dialectOf({ extendedToc, extendedHighlight, extendedSuperscript, extendedSubscript }),
    [extendedToc, extendedHighlight, extendedSuperscript, extendedSubscript],
  );
}
