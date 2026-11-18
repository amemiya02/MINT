import type { Platform } from "../platform/platform.ts";
import type { Settings } from "../settings/schema.ts";
import type { SettingsStore } from "../settings/settings.ts";
import { defaultTheme, findBuiltinTheme } from "./catalog.ts";

/**
 * Applies the look chosen in settings to the page:
 *
 * - `appearance`: `data-appearance="light" | "dark"` on <html>, following the
 *   system's preference unless pinned. Themes key their dark values off it.
 * - `theme`: a bundled or user stylesheet layered over the base stylesheet.
 *   The user theme folder is watched: adding,
 *   editing or removing a theme takes effect at once.
 * - Font, size, line height and content width: set as theme variables on
 *   <html> itself, so they win over any theme.
 */
export interface ThemeState {
  /** Absolute path of the theme folder ("" until known). */
  readonly folder: string;
  /** Names of the user themes in the theme folder, sorted. */
  readonly themes: readonly string[];
  /** Why the chosen user theme is not in use, if it is not. */
  readonly issue: ThemeIssue | null;
}

export type ThemeIssue =
  | { readonly kind: "missing"; readonly name: string }
  | { readonly kind: "unreadable"; readonly name: string; readonly reason: string };

export interface ThemeStore {
  getSnapshot(): ThemeState;
  subscribe(listener: () => void): () => void;
}

const themeExtension = ".css";
/** The <style> element that holds the selected theme. */
const selectedThemeId = "mint-selected-theme";

export async function createThemeStore(
  platform: Platform,
  settings: SettingsStore,
): Promise<ThemeStore> {
  const listeners = new Set<() => void>();
  let state: ThemeState = { folder: "", themes: [], issue: null };
  const update = (next: Partial<ThemeState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const current = () => settings.getSnapshot().settings;

  const applyAppearance = () => {
    const { appearance } = current();
    const dark = appearance === "dark" || (appearance === "system" && systemDark.matches);
    root.dataset.appearance = dark ? "dark" : "light";
  };

  const applyTypography = (s: Settings) => {
    root.style.setProperty("--mint-font-size", `${s.fontSize}px`);
    root.style.setProperty("--mint-line-height", String(s.lineHeight));
    root.style.setProperty("--mint-content-width", `${s.contentWidth}px`);
    if (s.fontFamily.trim() === "") root.style.removeProperty("--mint-font-editor");
    else root.style.setProperty("--mint-font-editor", s.fontFamily);
  };

  const styleElement = () => {
    let style = document.getElementById(selectedThemeId);
    if (!style) {
      style = document.createElement("style");
      style.id = selectedThemeId;
      // Last in <head>: after the base stylesheet, so equally specific rules win.
      document.head.append(style);
    }
    return style;
  };

  // Loads can overlap (a burst of file events); only the latest one may apply.
  let generation = 0;
  const loadTheme = async () => {
    const run = ++generation;
    const name = current().theme;
    const folder = state.folder;
    const builtin = findBuiltinTheme(name);
    let css = builtin?.css ?? defaultTheme.css;
    let issue: ThemeIssue | null = null;
    let found: ThemeFile[] = [];
    try {
      found = folder ? await listThemes(platform, folder) : [];
    } catch {
      // An unreadable folder has no themes; the chosen one is reported missing.
    }
    if (!builtin) {
      const file = found.find((theme) => theme.name === name);
      if (!file) {
        issue = { kind: "missing", name };
      } else {
        try {
          css = await platform.readTextFile(file.path);
        } catch (e) {
          issue = { kind: "unreadable", name, reason: e instanceof Error ? e.message : String(e) };
        }
      }
    }
    if (run !== generation) return;
    const style = styleElement();
    if (style.textContent !== css) style.textContent = css;
    update({ themes: found.map((theme) => theme.name), issue });
  };

  applyAppearance();
  applyTypography(current());
  systemDark.addEventListener("change", applyAppearance);

  let previous = current();
  settings.subscribe(() => {
    const next = current();
    if (next === previous) return;
    if (next.appearance !== previous.appearance) applyAppearance();
    applyTypography(next);
    if (next.theme !== previous.theme) void loadTheme();
    previous = next;
  });

  try {
    const folder = await platform.themesPath();
    update({ folder });
    await platform.watchFolder(folder, () => void loadTheme());
  } catch (e) {
    // Without a theme folder MINT still runs on its built-in themes.
    console.warn("MINT: the theme folder is unavailable", e);
  }
  // Before the first render, so the selected theme never flashes in late.
  await loadTheme();

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The selected stylesheet. Rejects if a custom theme is missing or unreadable.
 */
export async function readTheme(platform: Platform, folder: string, name: string): Promise<string> {
  const builtin = findBuiltinTheme(name);
  if (builtin) return builtin.css;
  const file = (await listThemes(platform, folder)).find((theme) => theme.name === name);
  if (!file) throw new Error(`The theme "${name}" is not in ${folder}`);
  return platform.readTextFile(file.path);
}

/** The typography settings as theme variables; like on screen, they override the theme's. */
export function typographyCss(s: Settings): string {
  const variables = [
    `--mint-font-size: ${s.fontSize}px;`,
    `--mint-line-height: ${s.lineHeight};`,
    `--mint-content-width: ${s.contentWidth}px;`,
    ...(s.fontFamily.trim() === "" ? [] : [`--mint-font-editor: ${s.fontFamily};`]),
  ];
  // More specific than a theme's `:root[data-appearance="dark"]`.
  return `html:root[data-appearance] { ${variables.join(" ")} }`;
}

interface ThemeFile {
  readonly name: string;
  readonly path: string;
}

/** The user themes in `folder`: every `.css` file, named after the file without its extension. */
async function listThemes(platform: Platform, folder: string): Promise<ThemeFile[]> {
  const entries = await platform.readDirectory(folder);
  return entries
    .filter((e) => e.kind === "file" && e.name.toLowerCase().endsWith(themeExtension))
    .map((e) => ({ name: e.name.slice(0, -themeExtension.length), path: e.path }))
    .filter((theme) => theme.name !== "")
    .sort((a, b) => a.name.localeCompare(b.name));
}
