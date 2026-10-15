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

  it('declares the colour scheme, a transparent canvas and the view CSP', () => {
    expect(doc).toContain(':root{color-scheme:dark}html,body{background:transparent}');
    expect(doc).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
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
