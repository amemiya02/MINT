import type { EditorDialect } from "@mint/editor";
import { useMemo } from "react";
import { dialectOf } from "./dialect.ts";
import { useSettings } from "./useSettings.ts";

/** The current dialect; a new object only when one of its switches changes. */
export function useDialect(wikilinks = false): EditorDialect {
  const { extendedToc, extendedHighlight, extendedSuperscript, extendedSubscript } =
    useSettings().settings;
  return useMemo(
    () => ({
      ...dialectOf({ extendedToc, extendedHighlight, extendedSuperscript, extendedSubscript }),
      wikilinks,
    }),
    [extendedToc, extendedHighlight, extendedSuperscript, extendedSubscript, wikilinks],
  );
}
