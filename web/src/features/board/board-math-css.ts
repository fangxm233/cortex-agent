import katexCss from 'katex/dist/katex.min.css?raw';
import AMSRegular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?data-uri';
import CaligraphicBold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?data-uri';
import CaligraphicRegular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?data-uri';
import FrakturBold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?data-uri';
import FrakturRegular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?data-uri';
import MainBold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?data-uri';
import MainBoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?data-uri';
import MainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?data-uri';
import MainRegular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?data-uri';
import MathBoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?data-uri';
import MathItalic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?data-uri';
import SansSerifBold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?data-uri';
import SansSerifItalic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?data-uri';
import SansSerifRegular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?data-uri';
import ScriptRegular from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?data-uri';
import Size1Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?data-uri';
import Size2Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?data-uri';
import Size3Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?data-uri';
import Size4Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?data-uri';
import TypewriterRegular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?data-uri';
import { inlineKatexFonts } from './board-math';

// KaTeX's stylesheet for the board frame, fonts inlined (~350 KB). Imported lazily, only by a board
// that has a formula, so nothing else pays for it.

export const KATEX_FONTS: Record<string, string> = {
  'KaTeX_AMS-Regular': AMSRegular,
  'KaTeX_Caligraphic-Bold': CaligraphicBold,
  'KaTeX_Caligraphic-Regular': CaligraphicRegular,
  'KaTeX_Fraktur-Bold': FrakturBold,
  'KaTeX_Fraktur-Regular': FrakturRegular,
  'KaTeX_Main-Bold': MainBold,
  'KaTeX_Main-BoldItalic': MainBoldItalic,
  'KaTeX_Main-Italic': MainItalic,
  'KaTeX_Main-Regular': MainRegular,
  'KaTeX_Math-BoldItalic': MathBoldItalic,
  'KaTeX_Math-Italic': MathItalic,
  'KaTeX_SansSerif-Bold': SansSerifBold,
  'KaTeX_SansSerif-Italic': SansSerifItalic,
  'KaTeX_SansSerif-Regular': SansSerifRegular,
  'KaTeX_Script-Regular': ScriptRegular,
  'KaTeX_Size1-Regular': Size1Regular,
  'KaTeX_Size2-Regular': Size2Regular,
  'KaTeX_Size3-Regular': Size3Regular,
  'KaTeX_Size4-Regular': Size4Regular,
  'KaTeX_Typewriter-Regular': TypewriterRegular,
};

export const BOARD_MATH_CSS = inlineKatexFonts(katexCss, KATEX_FONTS);
