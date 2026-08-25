// input:  browser-target pure helpers
// output: pinned behaviour for URL normalization, the origin guard and history math
// pos:    unit tests for the browser pane model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  EMPTY_HISTORY,
  WEB_SANDBOX,
  browserItemName,
  canGoBack,
  canGoForward,
  currentUrl,
  goBack,
  goForward,
  normalizeBrowserUrl,
  previewOriginConflict,
  pushHistory,
} from './browser-target';

describe('normalizeBrowserUrl', () => {
  it('reads a bare port as a loopback dev server', () => {
    expect(normalizeBrowserUrl('5173')).toBe('http://127.0.0.1:5173/');
    expect(normalizeBrowserUrl('  3000 ')).toBe('http://127.0.0.1:3000/');
  });

  it('defaults a scheme-less host to http (dev servers are never https)', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserUrl('127.0.0.1:8080/app')).toBe('http://127.0.0.1:8080/app');
  });

  it('keeps an explicit scheme', () => {
    expect(normalizeBrowserUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  it('refuses anything that is not http(s)', () => {
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBrowserUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeBrowserUrl('')).toBeNull();
    expect(normalizeBrowserUrl('   ')).toBeNull();
  });

  it('refuses an out-of-range port', () => {
    expect(normalizeBrowserUrl('99999')).toBeNull();
  });
});

describe('previewOriginConflict — the pane security boundary', () => {
  const APP = 'cortexui://localhost';
  const API = 'https://app-lab2.fangxm.me';

  it('allows a forwarded loopback target', () => {
    expect(previewOriginConflict('http://127.0.0.1:5173/', [APP, API])).toBe(false);
  });

  it('refuses the app page origin (frame would own the injected token + Tauri IPC)', () => {
    expect(previewOriginConflict('cortexui://localhost/index.html', [APP, API])).toBe(true);
  });

  it('refuses the API origin (frame could ride the Access cookie in browser mode)', () => {
    expect(previewOriginConflict('https://app-lab2.fangxm.me/trpc/x', [APP, API])).toBe(true);
    expect(previewOriginConflict('https://app-lab2.fangxm.me/', [API])).toBe(true);
  });

  it('treats a different port on the same host as a different origin', () => {
    expect(previewOriginConflict('http://127.0.0.1:3005/', ['http://127.0.0.1:5173'])).toBe(false);
  });

  it('refuses unparseable input rather than assuming it is safe', () => {
    expect(previewOriginConflict('not a url', [APP])).toBe(true);
  });

  it('ignores empty origins (browser mode has a relative API base)', () => {
    expect(previewOriginConflict('http://127.0.0.1:5173/', ['', null, undefined])).toBe(false);
  });
});

describe('WEB_SANDBOX', () => {
  it('never grants top-level navigation', () => {
    expect(WEB_SANDBOX).not.toContain('allow-top-navigation');
  });

  it('grants same-origin — which is why previewOriginConflict must stay strict', () => {
    expect(WEB_SANDBOX).toContain('allow-same-origin');
  });
});

describe('history', () => {
  it('starts empty', () => {
    expect(currentUrl(EMPTY_HISTORY)).toBeNull();
    expect(canGoBack(EMPTY_HISTORY)).toBe(false);
    expect(canGoForward(EMPTY_HISTORY)).toBe(false);
  });

  it('pushes and walks back and forward', () => {
    let h = pushHistory(EMPTY_HISTORY, 'http://a/');
    h = pushHistory(h, 'http://b/');
    expect(currentUrl(h)).toBe('http://b/');
    h = goBack(h);
    expect(currentUrl(h)).toBe('http://a/');
    expect(canGoForward(h)).toBe(true);
    h = goForward(h);
    expect(currentUrl(h)).toBe('http://b/');
  });

  it('re-entering the current URL is a no-op', () => {
    const h = pushHistory(EMPTY_HISTORY, 'http://a/');
    expect(pushHistory(h, 'http://a/')).toBe(h);
  });

  it('drops forward entries when navigating from the middle', () => {
    let h = pushHistory(pushHistory(EMPTY_HISTORY, 'http://a/'), 'http://b/');
    h = goBack(h);
    h = pushHistory(h, 'http://c/');
    expect(h.entries).toEqual(['http://a/', 'http://c/']);
    expect(canGoForward(h)).toBe(false);
  });

  it('caps the stack', () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < 60; i += 1) h = pushHistory(h, `http://h/${i}`);
    expect(h.entries.length).toBe(50);
    expect(currentUrl(h)).toBe('http://h/59');
  });
});

describe('browserItemName', () => {
  it('shows host:port and a non-root path', () => {
    expect(browserItemName('http://127.0.0.1:5173/')).toBe('127.0.0.1:5173');
    expect(browserItemName('http://localhost:3000/admin')).toBe('localhost:3000/admin');
  });
});
