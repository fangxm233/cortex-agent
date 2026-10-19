import { readFileSync } from 'node:fs';
import path from 'node:path';
import { boardEn, boardZh } from '@/i18n/board-vocab';
import { describe, expect, it, vi } from 'vitest';
import { VIEW_SANDBOX } from '@/features/media/html-sandbox';
import {
  assembleBoardDocument, parseBoardMessage, readThemeVars, referencedVars, themeVarsCss,
} from './board-document';

describe('referencedVars', () => {
  it('collects every var() name across stylesheets and body, once, in first-seen order', () => {
    const css = '.card{background:var(--material-card-bg);border:1px solid var( --border-card )}';
    const user = ':root{--proto-accent:red}.chip{color:var(--proto-accent)}';
    const body = '<span style="background:var(--proto-success)">x</span><i style="color:var(--material-card-bg)"></i>';
    expect(referencedVars(css, null, user, undefined, body)).toEqual([
      '--material-card-bg', '--border-card', '--proto-accent', '--proto-success',
    ]);
  });
});

describe('themeVarsCss', () => {
  it('declares only names the app resolves and drops values that could break out', () => {
    const values: Record<string, string> = {
      '--proto-ink': ' oklch(0.2 0.01 263) ',
      '--b-gap': '',
      '--evil': 'red;}body{display:none',
      '--tag': '</style><script>',
    };
    expect(themeVarsCss(['--proto-ink', '--b-gap', '--evil', '--tag', '--missing'], (n) => values[n] ?? ''))
      .toBe(':root{--proto-ink:oklch(0.2 0.01 263)}');
  });

  it('is empty when nothing resolves', () => {
    expect(themeVarsCss(['--b-gap'], () => '')).toBe('');
  });

  it('reads values off the root\'s computed style', () => {
    const root = {} as Element;
    const seen: unknown[] = [];
    vi.stubGlobal('getComputedStyle', (el: unknown) => {
      seen.push(el);
      return { getPropertyValue: (name: string) => (name === '--proto-accent' ? '#4655d4' : '') };
    });
    expect(readThemeVars(['--proto-accent', '--b-font'], root)).toBe(':root{--proto-accent:#4655d4}');
    expect(seen).toEqual([root]);
    vi.unstubAllGlobals();
  });
});

describe('assembleBoardDocument', () => {
  const doc = assembleBoardDocument({
    themeCss: ':root{--proto-accent:#123456}',
    defaultCss: '.card{border-radius:var(--r-card)}',
    userCss: '.card{border-radius:0}',
    body: '<div class="card">BODY</div>',
    pendingContent: 'Pending',
    theme: 'dark',
  });

  it('stacks theme variables, preset, user override, then the body', () => {
    const at = (needle: string) => doc.indexOf(needle);
    expect(at('--proto-accent:#123456')).toBeGreaterThan(0);
    expect(at('--proto-accent:#123456')).toBeLessThan(at('border-radius:var(--r-card)'));
    expect(at('border-radius:var(--r-card)')).toBeLessThan(at('.card{border-radius:0}'));
    expect(at('.card{border-radius:0}')).toBeLessThan(at('<body>'));
    expect(doc.endsWith('<body><div class="card">BODY</div></body></html>')).toBe(true);
  });

  it('declares the colour scheme, a transparent canvas, a root that never scrolls and the view CSP', () => {
    expect(doc).toContain(':root{color-scheme:dark}html,body{background:transparent}html{overflow:hidden}');
    expect(doc).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
  });

  it('stacks KaTeX between the theme and the preset, only when the body has formulas', () => {
    const withMath = assembleBoardDocument({ themeCss: '', mathCss: '.katex{font:1em KaTeX_Main}', defaultCss: 'a{}',
      userCss: null, body: '', pendingContent: 'Pending', theme: 'light' });
    const at = (needle: string) => withMath.indexOf(needle);
    expect(at('data-board-layer="theme"')).toBeLessThan(at('data-board-layer="math"'));
    expect(at('data-board-layer="math"')).toBeLessThan(at('data-board-layer="preset"'));
    expect(doc).not.toContain('data-board-layer="math"');
  });

  it('omits the user layer when there is no override', () => {
    const plain = assembleBoardDocument({ themeCss: '', defaultCss: 'a{}', userCss: null, body: '', pendingContent: 'Pending', theme: 'light' });
    expect(plain).not.toContain('data-board-layer="user"');
  });

  it('keeps a stylesheet from closing its own element', () => {
    const hostile = assembleBoardDocument({ themeCss: '', defaultCss: 'a{}', userCss: '</style><script>alert(1)</script>', body: '', pendingContent: 'Pending', theme: 'light' });
    expect(hostile).not.toContain('</style><script>alert(1)');
  });

  it.each([boardEn, boardZh])('shows only the title and localized empty state in the shipped scaffold', (vocab) => {
    const scaffold = readFileSync(path.resolve(import.meta.dirname, '../../../../agent-server/defaults/board/scaffold.html'), 'utf8');
    const body = scaffold.replaceAll('{{title}}', 'A &amp; B');
    const rendered = assembleBoardDocument({ themeCss: '', defaultCss: '', userCss: null, body,
      pendingContent: vocab.boardPendingContent, theme: 'light' });
    const visible = rendered.split('<body>')[1]!.split('</body>')[0]!.replace(/<!--[\s\S]*?-->/g, '');
    expect(visible.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
      .toBe(`A &amp; B ${vocab.boardPendingContent}`);
    expect(visible).not.toMatch(/chip|meter|MM-DD|Stage|GPU|Needs you/);
    expect(rendered).toContain('COMPONENT EXAMPLES');
    expect(rendered).toContain('What stage 1 delivers');
  });

  it('escapes empty-state text and does not interpret replacement patterns', () => {
    const rendered = assembleBoardDocument({ themeCss: '', defaultCss: '', userCss: null,
      body: '<p>{{boardPendingContent}}</p>', pendingContent: '<b>A & B</b> $&', theme: 'light' });
    expect(rendered).toContain('<p>&lt;b&gt;A &amp; B&lt;/b&gt; $&amp;</p>');
  });

  it('is meant for the view sandbox and nothing wider', () => {
    expect(VIEW_SANDBOX).toBe('allow-scripts');
  });
});

describe('the shipped preset', () => {
  const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
  const preset = read('../../../../agent-server/defaults/board/board.css');
  /** Custom properties a stylesheet declares (`--x:`), at any nesting. */
  const declared = (css: string) => new Set([...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]!));
  /** `selector { … }` rules, flattened out of @media blocks, comments dropped. */
  const rules = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

  it('takes every variable it reads from the app (so the frame is handed it) or defines it itself', () => {
    const app = new Set([...declared(read('../../../public/theme.css')), ...declared(read('../../index.css'))]);
    const own = declared(preset);
    const withFallback = new Set([...preset.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*,/g)].map((m) => m[1]!));
    const unresolved = referencedVars(preset).filter((name) => !app.has(name) && !own.has(name) && !withFallback.has(name));
    expect(unresolved).toEqual([]);
    // The app's two faces reach the frame through the same hand-over as the colours.
    expect(referencedVars(preset)).toEqual(expect.arrayContaining(['--font-ui', '--font-code']));
  });

  it('keeps the mono face for code and drops capitals and letter-spaced labels', () => {
    const mono = rules(preset).filter((r) => r.body.includes('var(--b-mono)')).map((r) => r.selector);
    expect(mono.sort()).toEqual(['.mono', '.row .id', 'code', 'pre'].sort());
    expect(preset).not.toMatch(/text-transform\s*:\s*uppercase/);
    expect(rules(preset).filter((r) => /letter-spacing\s*:\s*[0-9.]*[1-9]/.test(r.body)).map((r) => r.selector)).toEqual([]);
  });

  it('draws sections, chips and steps without boxes; only a callout is boxed', () => {
    const body = (selector: string) => rules(preset).filter((r) => r.selector.split(',').map((s) => s.trim()).includes(selector))
      .map((r) => r.body).join(';');
    for (const quiet of ['.card', '.chip', '.step']) {
      expect(body(quiet), quiet).not.toMatch(/box-shadow|border-radius:\s*var\(--r-card\)|background:\s*var\(--material/);
      expect(body(quiet), quiet).not.toMatch(/(^|;)\s*border\s*:(?!\s*0\s*(;|$))/);
    }
    expect(body('.callout')).toMatch(/border:\s*1px solid/);
    // Every class boards were written with is still styled.
    for (const cls of ['.stack', '.grid', '.h', '.head', '.lead', '.chip', '.meter', '.legend', '.steps', '.rows', '.row', '.ic', '.tl', '.gallery', '.tex', '.tbl', '.num', '.mono', '.muted', '.faint']) {
      expect(preset, cls).toContain(cls);
    }
  });
});

describe('the shipped preset on a narrow page', () => {
  const preset = readFileSync(path.resolve(import.meta.dirname, '../../../../agent-server/defaults/board/board.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const body = (selector: string) => [...preset.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.split(',').map((x) => x.trim()).includes(selector)).map((m) => m[2]!).join(';');

  it('keeps headers and figures on one line and scrolls a too-wide table instead', () => {
    expect(body('th')).toMatch(/white-space:\s*nowrap/);
    expect(body('td.num')).toMatch(/white-space:\s*nowrap/);
    expect(body('.tbl')).toMatch(/overflow-x:\s*auto/);
    const narrow = preset.match(/@media \(max-width: 560px\) \{\s*table:not\(\.tbl table\) \{([^}]*)\}/);
    expect(narrow?.[1]).toMatch(/display:\s*block;\s*overflow-x:\s*auto/);
  });

  it('lets a wrapped updated time start the next line at the left, not on its own at the right', () => {
    expect(body('.head .meta')).not.toMatch(/margin-left:\s*auto/);
    expect(body('.head .meta')).toMatch(/order:\s*2/);
    expect(body('.head::after')).toMatch(/order:\s*1;\s*flex:\s*1 1 0/);
  });
});

describe('parseBoardMessage', () => {
  it('accepts the three board messages', () => {
    expect(parseBoardMessage({ __cortexBoard: 'height', value: 812.4 })).toEqual({ type: 'height', value: 812 });
    expect(parseBoardMessage({ __cortexBoard: 'open', path: 'assets/a.png' })).toEqual({ type: 'open', path: 'assets/a.png' });
    expect(parseBoardMessage({ __cortexBoard: 'link', href: 'https://example.com/x' }))
      .toEqual({ type: 'link', href: 'https://example.com/x' });
  });

  it('rejects anything else', () => {
    expect(parseBoardMessage(null)).toBeNull();
    expect(parseBoardMessage({ __cortexView: 'height', value: 10 })).toBeNull();
    expect(parseBoardMessage({ __cortexBoard: 'height', value: 'x' })).toBeNull();
    expect(parseBoardMessage({ __cortexBoard: 'open', path: '' })).toBeNull();
    expect(parseBoardMessage({ __cortexBoard: 'link', href: 'javascript:alert(1)' })).toBeNull();
  });
});
