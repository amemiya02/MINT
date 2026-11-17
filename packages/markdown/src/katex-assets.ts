/// <reference path="./assets.d.ts" />
// KaTeX's stylesheet with its fonts embedded, for exported documents. Imported
// lazily (a separate chunk of about 400 KB) the first time a document with
// math is exported, never on the editor's startup path.

import AMSRegular from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline";
import CaligraphicBold from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline";
import CaligraphicRegular from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline";
import FrakturBold from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline";
import FrakturRegular from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline";
import MainBold from "katex/dist/fonts/KaTeX_Main-Bold.woff2?inline";
import MainBoldItalic from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline";
import MainItalic from "katex/dist/fonts/KaTeX_Main-Italic.woff2?inline";
import MainRegular from "katex/dist/fonts/KaTeX_Main-Regular.woff2?inline";
import MathBoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline";
import MathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff2?inline";
import SansSerifBold from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline";
import SansSerifItalic from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline";
import SansSerifRegular from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline";
import ScriptRegular from "katex/dist/fonts/KaTeX_Script-Regular.woff2?inline";
import Size1Regular from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline";
import Size2Regular from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline";
import Size3Regular from "katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline";
import Size4Regular from "katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline";
import TypewriterRegular from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline";
import katexCss from "katex/dist/katex.min.css?raw";

/** Data URIs of the WOFF2 fonts, by file name without extension. */
const fonts: Readonly<Record<string, string>> = {
  "KaTeX_AMS-Regular": AMSRegular,
  "KaTeX_Caligraphic-Bold": CaligraphicBold,
  "KaTeX_Caligraphic-Regular": CaligraphicRegular,
  "KaTeX_Fraktur-Bold": FrakturBold,
  "KaTeX_Fraktur-Regular": FrakturRegular,
  "KaTeX_Main-Bold": MainBold,
  "KaTeX_Main-BoldItalic": MainBoldItalic,
  "KaTeX_Main-Italic": MainItalic,
  "KaTeX_Main-Regular": MainRegular,
  "KaTeX_Math-BoldItalic": MathBoldItalic,
  "KaTeX_Math-Italic": MathItalic,
  "KaTeX_SansSerif-Bold": SansSerifBold,
  "KaTeX_SansSerif-Italic": SansSerifItalic,
  "KaTeX_SansSerif-Regular": SansSerifRegular,
  "KaTeX_Script-Regular": ScriptRegular,
  "KaTeX_Size1-Regular": Size1Regular,
  "KaTeX_Size2-Regular": Size2Regular,
  "KaTeX_Size3-Regular": Size3Regular,
  "KaTeX_Size4-Regular": Size4Regular,
  "KaTeX_Typewriter-Regular": TypewriterRegular,
};

/**
 * KaTeX's stylesheet with each font's source list (WOFF2, WOFF and TrueType
 * files next to the stylesheet) replaced by the embedded WOFF2 font, so math
 * renders with no file or network access.
 */
export function embeddedKatexCss(): string {
  if (katexCss === "") throw new Error("The KaTeX stylesheet was not bundled");
  return katexCss.replace(
    /src:\s*url\(fonts\/([\w-]+)\.woff2\)[^;}]*/g,
    (_source: string, name: string) => {
      const font = fonts[name];
      if (!font) throw new Error(`KaTeX font ${name} is not embedded`);
      return `src:url(${font}) format("woff2")`;
    },
  );
}
