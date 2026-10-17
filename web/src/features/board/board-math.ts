import katex from 'katex';
import { outsideComments } from './board-assets';

// Formulas on a board: `<span class="tex">…</span>` inline, `<div class="tex">…</div>` on its own
// line, the content written as TeX text. The parent renders them with KaTeX before the body goes
// into the frame (the frame has no KaTeX of its own), with the options the chat uses. The frame
// then needs KaTeX's stylesheet with its fonts inlined; board-math-css.ts carries that.

const CLASS_TOKEN = String.raw`\sclass\s*=\s*(?:"(?:[^"]*\s)?tex(?:\s[^"]*)?"|'(?:[^']*\s)?tex(?:\s[^']*)?'|tex(?=[\s/>]))`;
const TEX_PATTERN = String.raw`<(span|div)\b(?=[^>]*${CLASS_TOKEN})([^>]*)>([\s\S]*?)<\/\1\s*>`;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

const KATEX_OPTIONS = { throwOnError: false, trust: false, maxExpand: 1000, maxSize: 50 } as const;

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
const ENTITY = /&(?:(lt|gt|amp|quot|apos|nbsp)|#(\d+)|#x([0-9a-f]+));/gi;

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, name?: string, dec?: string, hex?: string) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function renderTex(whole: string, tag: string, attrs: string, tex: string): string {
  try {
    const markup = katex.renderToString(decodeEntities(tex), { ...KATEX_OPTIONS, displayMode: tag.toLowerCase() === 'div' });
    return `<${tag}${attrs}>${markup}</${tag}>`;
  } catch {
    return whole;
  }
}

export function hasBoardMath(html: string): boolean {
  return new RegExp(TEX_PATTERN, 'i').test(html.replace(COMMENT, ''));
}

/** The body with every `.tex` span/div outside comments rendered as KaTeX markup. */
export function renderBoardMath(html: string): string {
  const tex = new RegExp(TEX_PATTERN, 'gi');
  return outsideComments(html, (part) => part.replace(tex, renderTex));
}

const FONT_SRC = /src:url\(fonts\/(KaTeX_[\w-]+)\.woff2\)[^;}]*/g;

/** KaTeX's stylesheet with each font face pointed at its data URI (woff2 only; every engine the
 *  app runs in reads it). A face with no URI keeps its file reference and falls back in the frame. */
export function inlineKatexFonts(css: string, fonts: Record<string, string>): string {
  return css.replace(FONT_SRC, (whole, name: string) => {
    const uri = fonts[name];
    return uri ? `src:url(${uri}) format("woff2")` : whole;
  });
}
