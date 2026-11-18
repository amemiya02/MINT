import type { MessageKey } from "../i18n/index.ts";
import academic from "./academic.css?raw";
import blueprint from "./blueprint.css?raw";
import bookleaf from "./bookleaf.css?raw";
import cobalt from "./cobalt.css?raw";
import dracula from "./dracula.css?raw";
import drake from "./drake.css?raw";
import dusk from "./dusk.css?raw";
import gitbook from "./gitbook.css?raw";
import github from "./github.css?raw";
import gothic from "./gothic.css?raw";
import ladder from "./ladder.css?raw";
import lapis from "./lapis.css?raw";
import mdmdt from "./mdmdt.css?raw";
import newsprint from "./newsprint.css?raw";
import night from "./night.css?raw";
import notion from "./notion.css?raw";
import pie from "./pie.css?raw";
import pixyll from "./pixyll.css?raw";
import purple from "./purple.css?raw";
import sage from "./sage.css?raw";
import typoraLatex from "./typora-latex.css?raw";
import ursine from "./ursine.css?raw";
import vue from "./vue.css?raw";
import whitey from "./whitey.css?raw";

interface BuiltinTheme {
  readonly id: string;
  readonly label: MessageKey;
  readonly css: string;
}

export const defaultTheme: BuiltinTheme = { id: "", label: "theme.builtin.github", css: github };

// A slash cannot occur in a theme filename, so the built-in IDs and user names never collide.
const originals: readonly BuiltinTheme[] = [
  { id: "builtin/sage", label: "theme.builtin.sage", css: sage },
  { id: "builtin/bookleaf", label: "theme.builtin.bookleaf", css: bookleaf },
  { id: "builtin/blueprint", label: "theme.builtin.blueprint", css: blueprint },
  { id: "builtin/dusk", label: "theme.builtin.dusk", css: dusk },
];

export const themeGroups: readonly {
  label: MessageKey;
  themes: readonly BuiltinTheme[];
}[] = [
  { label: "settings.theme.builtins", themes: originals },
  {
    label: "settings.theme.typoraClassic",
    themes: [
      defaultTheme,
      { id: "builtin/gothic", label: "theme.builtin.gothic", css: gothic },
      { id: "builtin/newsprint", label: "theme.builtin.newsprint", css: newsprint },
      { id: "builtin/night", label: "theme.builtin.night", css: night },
      { id: "builtin/pixyll", label: "theme.builtin.pixyll", css: pixyll },
      { id: "builtin/whitey", label: "theme.builtin.whitey", css: whitey },
    ],
  },
  {
    label: "settings.theme.typoraCommunity",
    themes: [
      { id: "builtin/academic", label: "theme.builtin.academic", css: academic },
      { id: "builtin/cobalt", label: "theme.builtin.cobalt", css: cobalt },
      { id: "builtin/dracula", label: "theme.builtin.dracula", css: dracula },
      { id: "builtin/drake", label: "theme.builtin.drake", css: drake },
      { id: "builtin/gitbook", label: "theme.builtin.gitbook", css: gitbook },
      { id: "builtin/ladder", label: "theme.builtin.ladder", css: ladder },
      { id: "builtin/lapis", label: "theme.builtin.lapis", css: lapis },
      { id: "builtin/mdmdt", label: "theme.builtin.mdmdt", css: mdmdt },
      { id: "builtin/notion", label: "theme.builtin.notion", css: notion },
      { id: "builtin/pie", label: "theme.builtin.pie", css: pie },
      { id: "builtin/purple", label: "theme.builtin.purple", css: purple },
      { id: "builtin/typora-latex", label: "theme.builtin.typora-latex", css: typoraLatex },
      { id: "builtin/ursine", label: "theme.builtin.ursine", css: ursine },
      { id: "builtin/vue", label: "theme.builtin.vue", css: vue },
    ],
  },
];

const builtinThemes = themeGroups.flatMap((group) => group.themes);

export function findBuiltinTheme(id: string): BuiltinTheme | undefined {
  if (id === "builtin/github") return defaultTheme;
  return builtinThemes.find((theme) => theme.id === id);
}
