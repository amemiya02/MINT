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
import latex from "./latex.css?raw";
import mdmdt from "./mdmdt.css?raw";
import newsprint from "./newsprint.css?raw";
import night from "./night.css?raw";
import notion from "./notion.css?raw";
import pie from "./pie.css?raw";
import pixyll from "./pixyll.css?raw";
import purple from "./purple.css?raw";
import sage from "./sage.css?raw";
import ursine from "./ursine.css?raw";
import vue from "./vue.css?raw";
import whitey from "./whitey.css?raw";

interface BuiltinTheme {
  readonly id: string;
  readonly label: string;
  readonly css: string;
}

export const defaultTheme: BuiltinTheme = { id: "", label: "GitHub (default)", css: github };

const latexTheme: BuiltinTheme = { id: "builtin/latex", label: "LaTeX", css: latex };

// A slash cannot occur in a theme filename, so the built-in IDs and user names never collide.
export const builtinThemes: readonly BuiltinTheme[] = [
  defaultTheme,
  { id: "builtin/academic", label: "Academic", css: academic },
  { id: "builtin/blueprint", label: "Blueprint", css: blueprint },
  { id: "builtin/bookleaf", label: "Bookleaf", css: bookleaf },
  { id: "builtin/cobalt", label: "Cobalt", css: cobalt },
  { id: "builtin/dracula", label: "Dracula", css: dracula },
  { id: "builtin/drake", label: "Drake", css: drake },
  { id: "builtin/dusk", label: "Dusk", css: dusk },
  { id: "builtin/gitbook", label: "GitBook", css: gitbook },
  { id: "builtin/gothic", label: "Gothic", css: gothic },
  { id: "builtin/ladder", label: "Ladder", css: ladder },
  { id: "builtin/lapis", label: "Lapis", css: lapis },
  latexTheme,
  { id: "builtin/mdmdt", label: "Mdmdt", css: mdmdt },
  { id: "builtin/newsprint", label: "Newsprint", css: newsprint },
  { id: "builtin/night", label: "Night", css: night },
  { id: "builtin/notion", label: "Notion", css: notion },
  { id: "builtin/pie", label: "Pie", css: pie },
  { id: "builtin/pixyll", label: "Pixyll", css: pixyll },
  { id: "builtin/purple", label: "Purple", css: purple },
  { id: "builtin/sage", label: "Sage", css: sage },
  { id: "builtin/ursine", label: "Ursine", css: ursine },
  { id: "builtin/vue", label: "Vue", css: vue },
  { id: "builtin/whitey", label: "Whitey", css: whitey },
];

export function findBuiltinTheme(id: string): BuiltinTheme | undefined {
  if (id === "builtin/github") return defaultTheme;
  // Settings saved before the LaTeX theme was renamed still select the same stylesheet.
  if (id === "builtin/typora-latex") return latexTheme;
  return builtinThemes.find((theme) => theme.id === id);
}
