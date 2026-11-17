import type { Dialect } from "@mint/markdown";
import { useMemo } from "react";
import { dialectOf } from "./dialect.ts";
import { useSettings } from "./useSettings.ts";

/** The current dialect; a new object only when one of its switches changes. */
export function useDialect(): Dialect {
  const { extendedToc, extendedHighlight, extendedSuperscript, extendedSubscript } =
    useSettings().settings;
  return useMemo(
    () => dialectOf({ extendedToc, extendedHighlight, extendedSuperscript, extendedSubscript }),
    [extendedToc, extendedHighlight, extendedSuperscript, extendedSubscript],
  );
}
