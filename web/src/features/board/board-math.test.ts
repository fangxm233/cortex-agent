import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { KATEX_FONTS } from './board-math-css';
import { hasBoardMath, inlineKatexFonts, renderBoardMath } from './board-math';

describe('hasBoardMath', () => {
  it('spots a tex span or div by its class token, outside comments', () => {
    expect(hasBoardMath('<p>x <span class="tex">a^2</span></p>')).toBe(true);
    expect(hasBoardMath("<div class='big tex'>a</div>")).toBe(true);
    expect(hasBoardMath('<div class=tex>a</div>')).toBe(true);
    expect(hasBoardMath('<span class="text">a</span><span class="my-tex">b</span><p class="tex">c</p>')).toBe(false);
    expect(hasBoardMath('<!-- <span class="tex">a</span> -->')).toBe(false);
  });
});

describe('renderBoardMath', () => {
  it('renders inline spans and display divs with KaTeX, keeping the element and its attributes', () => {
    const out = renderBoardMath('<p>loss <span class="tex" id="l">x^2</span></p><div class="tex">\\frac{a}{b}</div>');
    expect(out).toMatch(/^<p>loss <span class="tex" id="l"><span class="katex">/);
    expect(out).not.toContain('katex-display"><span class="katex">x');
    expect(out).toMatch(/<div class="tex"><span class="katex-display">/);
    expect(out).toContain('<mfrac>');
  });

  it('reads the TeX as text, decoding entities', () => {
    const out = renderBoardMath('<span class="tex">a &lt; b \\land c &#62; d</span>');
    expect(out).toContain('<mo>&lt;</mo>');
    expect(out).toContain('<mo>&gt;</mo>');
    expect(out).not.toContain('katex-error');
    const aligned = renderBoardMath('<div class="tex">\\begin{aligned} a &amp;= b \\\\ c &= d \\end{aligned}</div>');
    expect(aligned).not.toContain('katex-error');
    expect(aligned).toContain('<mtable');
  });

  it('leaves comments, other elements and bad TeX safe', () => {
    const html = '<!-- <span class="tex">x</span> --><span class="text">x^2</span>';
    expect(renderBoardMath(html)).toBe(html);
    const bad = renderBoardMath('<span class="tex">\\frac{</span>');
    expect(bad).toContain('katex-error');
    expect(renderBoardMath('<span class="tex">\\href{javascript:alert(1)}{x}</span>')).not.toMatch(/href="/);
  });

  it('renders each formula in a board with several, across nesting', () => {
    const out = renderBoardMath('<div class="card"><span class="tex">a</span> and <div class="tex">b</div></div>');
    expect(out.match(/class="katex"/g)).toHaveLength(2);
    expect(out.endsWith('</div></div>')).toBe(true);
  });
});

describe('inlineKatexFonts', () => {
  it('points each font face at its data URI, woff2 only, and leaves unknown faces alone', () => {
    const css = '@font-face{font-family:A;src:url(fonts/KaTeX_A-Regular.woff2) format("woff2"),url(fonts/KaTeX_A-Regular.woff) format("woff")}'
      + '@font-face{font-family:B;src:url(fonts/KaTeX_B-Bold.woff2) format("woff2")}';
    expect(inlineKatexFonts(css, { 'KaTeX_A-Regular': 'data:font/woff2;base64,AA' })).toBe(
      '@font-face{font-family:A;src:url(data:font/woff2;base64,AA) format("woff2")}'
      + '@font-face{font-family:B;src:url(fonts/KaTeX_B-Bold.woff2) format("woff2")}',
    );
  });

  it('covers every font face of the installed KaTeX stylesheet', () => {
    const css = readFileSync(createRequire(import.meta.url).resolve('katex/dist/katex.min.css'), 'utf8');
    const out = inlineKatexFonts(css, KATEX_FONTS);
    expect(out).not.toMatch(/url\(fonts\//);
    expect(out.match(/src:url\(data:font\/woff2;base64,/g)?.length).toBe(css.match(/@font-face/g)?.length);
  });
});
