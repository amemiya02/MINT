import type { MessageKey } from "../i18n/index.ts";
import blueprint from "./blueprint.css?raw";
import bookleaf from "./bookleaf.css?raw";
import dusk from "./dusk.css?raw";
import sage from "./sage.css?raw";

interface BuiltinTheme {
  readonly id: string;
  readonly label: MessageKey;
  readonly css: string;
}

export const defaultTheme: BuiltinTheme = { id: "", label: "theme.builtin.sage", css: sage };

// A slash cannot occur in a theme filename, so the built-in IDs and user names never collide.
export const builtinThemes: readonly BuiltinTheme[] = [
  defaultTheme,
  { id: "builtin/bookleaf", label: "theme.builtin.bookleaf", css: bookleaf },
  { id: "builtin/blueprint", label: "theme.builtin.blueprint", css: blueprint },
  { id: "builtin/dusk", label: "theme.builtin.dusk", css: dusk },
];

export function findBuiltinTheme(id: string): BuiltinTheme | undefined {
  if (id === "builtin/sage") return defaultTheme;
  return builtinThemes.find((theme) => theme.id === id);
}
