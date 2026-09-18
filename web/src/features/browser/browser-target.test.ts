import { describe, it, expect } from 'vitest';
import {
  EMPTY_HISTORY,
  applyBrowserTitle,
  createBrowserTab,
  canGoBack,
  canGoForward,
  currentUrl,
  goBack,
  goForward,
  normalizeBrowserUrl,
  previewOriginConflict,
  pushHistory,
  frameRefusedEmbedding,
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

describe('browser tabs', () => {
  it('orders title loads but accepts a BFCache document restore', () => {
    const tab = { ...createBrowserTab('tab-a'), pageTitle: 'New title', titleTimeOrigin: 2000 };
    expect(applyBrowserTitle(tab, 'Old title', 1000, 'load')).toBe(tab);
    const newest = applyBrowserTitle(tab, 'Newest title', 3000, 'load');
    expect(newest).toMatchObject({ pageTitle: 'Newest title', titleTimeOrigin: 3000 });
    expect(applyBrowserTitle(newest, 'Restored title', 1000, 'restore')).toMatchObject({
      pageTitle: 'Restored title',
      titleTimeOrigin: 1000,
    });
    expect(applyBrowserTitle(newest, 'Wrong document', 1000, 'update')).toBe(newest);
  });
});

describe('frameRefusedEmbedding', () => {
  it('reads a still-reachable document after load as a refusal', () => {
    // A page that really loaded is cross-origin, so its contentDocument is null. Reaching one means
    // the frame never left the blank document it started on.
    expect(frameRefusedEmbedding({ loaded: true, documentReachable: true })).toBe(true);
  });

  it('treats an unreachable document as a successful load', () => {
    expect(frameRefusedEmbedding({ loaded: true, documentReachable: false })).toBe(false);
  });

  it('claims nothing before the load event', () => {
    // Mid-load the frame is legitimately still on the blank document; calling that a refusal would
    // flash the banner on every navigation.
    expect(frameRefusedEmbedding({ loaded: false, documentReachable: true })).toBe(false);
  });
});
