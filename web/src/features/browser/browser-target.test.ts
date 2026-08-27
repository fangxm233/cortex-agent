// input:  browser URL, history, title and forward helpers
// output: regressions for guards, history and tab identity
// pos:    Unit tests for the browser workspace model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import {
  EMPTY_HISTORY,
  WEB_SANDBOX,
  activeBrowserTab,
  addBrowserTab,
  applyBrowserTitle,
  browserItemName,
  browserTabChip,
  browserTabForwardSource,
  browserTabLabel,
  closeBrowserTab,
  createBrowserTab,
  createBrowserTabs,
  selectBrowserTab,
  updateBrowserTab,
  canGoBack,
  canGoForward,
  currentUrl,
  goBack,
  goForward,
  normalizeBrowserUrl,
  previewOriginConflict,
  pushHistory,
  reorderBrowserTabs,
  frameRefusedEmbedding,
  FRAME_REFUSED_HINT,
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

describe('browser tabs', () => {
  it('creates one blank active tab', () => {
    const state = createBrowserTabs('tab-a');
    expect(state.activeId).toBe('tab-a');
    expect(state.tabs).toEqual([createBrowserTab('tab-a')]);
    expect(currentUrl(activeBrowserTab(state).history)).toBeNull();
    expect(activeBrowserTab(state)).toMatchObject({ pageTitle: null, titleTimeOrigin: 0, documentGeneration: 0, forward: null });
  });

  it('keeps the page title and forwarded source as separate tab labels', () => {
    const targetUrl = 'http://127.0.0.1:41235/';
    const ready = {
      ...createBrowserTab('tab-a'),
      history: pushHistory(EMPTY_HISTORY, targetUrl),
      pageTitle: 'Robot Dashboard',
      forward: { status: 'ready' as const, device: 'my-pc', originalPort: 6006, targetUrl },
    };
    expect(browserTabLabel(ready)).toBe('Robot Dashboard');
    expect(browserTabForwardSource(ready)).toBe('my-pc:6006');
    expect(browserTabForwardSource({
      ...ready,
      history: pushHistory(ready.history, 'https://example.com/'),
    })).toBeNull();
  });

  it('shows a connecting source before the forwarded URL exists', () => {
    const tab = {
      ...createBrowserTab('tab-a'),
      forward: { status: 'connecting' as const, operationId: 7, device: 'lab', originalPort: 3000 },
    };
    expect(browserTabLabel(tab)).toBe('New tab');
    expect(browserTabForwardSource(tab)).toBe('lab:3000');
  });

  it('chips a forward with its original device:port and a plain address with its own port', () => {
    const targetUrl = 'http://127.0.0.1:41235/';
    const history = pushHistory(EMPTY_HISTORY, targetUrl);
    const forwarded = {
      ...createBrowserTab('tab-a'),
      history,
      forward: { status: 'ready' as const, device: 'my-pc', originalPort: 6006, targetUrl },
    };
    expect(browserTabChip(forwarded)).toEqual({ text: 'my-pc:6006', kind: 'forward' });
    expect(browserTabChip({
      ...forwarded,
      forward: { status: 'ready' as const, device: '', originalPort: 5173, targetUrl },
    })).toEqual({ text: ':5173', kind: 'forward' });
    expect(browserTabChip({ ...createBrowserTab('tab-b'), history })).toEqual({ text: ':41235', kind: 'plain' });
  });

  it('drops the chip, and keeps the port in the label, when the URL carries no port', () => {
    const tab = { ...createBrowserTab('tab-a'), history: pushHistory(EMPTY_HISTORY, 'https://example.com/docs') };
    expect(browserTabChip(tab)).toBeNull();
    expect(browserTabLabel(tab)).toBe('example.com/docs');
    expect(browserTabChip(createBrowserTab('tab-b'))).toBeNull();
  });

  it('spells the port once: the chip shows it, so the label drops it', () => {
    const tab = { ...createBrowserTab('tab-a'), history: pushHistory(EMPTY_HISTORY, 'http://localhost:3000/admin') };
    expect(browserTabChip(tab)).toEqual({ text: ':3000', kind: 'plain' });
    expect(browserTabLabel(tab)).toBe('localhost/admin');
  });

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

  it('keeps every tab pane state independent', () => {
    let state = createBrowserTabs('tab-a');
    state = updateBrowserTab(state, 'tab-a', (tab) => ({
      ...tab,
      history: pushHistory(tab.history, 'http://a/'),
      draft: 'draft-a',
      viewportId: 'phone',
      reloadNonce: 2,
      rejected: 'error-a',
      refused: true,
    }));
    state = addBrowserTab(state, createBrowserTab('tab-b'));
    state = updateBrowserTab(state, 'tab-b', (tab) => ({
      ...tab,
      history: pushHistory(tab.history, 'http://b/'),
      draft: 'draft-b',
      viewportId: 'desktop',
    }));

    const a = state.tabs.find((tab) => tab.id === 'tab-a');
    const b = state.tabs.find((tab) => tab.id === 'tab-b');
    expect(a).toMatchObject({ draft: 'draft-a', viewportId: 'phone', reloadNonce: 2, rejected: 'error-a', refused: true });
    expect(currentUrl(a!.history)).toBe('http://a/');
    expect(b).toMatchObject({ draft: 'draft-b', viewportId: 'desktop', reloadNonce: 0, rejected: null, refused: false });
    expect(currentUrl(b!.history)).toBe('http://b/');
  });

  it('selects tabs without changing their contents', () => {
    const original = addBrowserTab(createBrowserTabs('tab-a'), createBrowserTab('tab-b'));
    const selected = selectBrowserTab(original, 'tab-a');
    expect(selected.activeId).toBe('tab-a');
    expect(selected.tabs).toBe(original.tabs);
  });

  it('reorders tabs without changing active or per-tab state', () => {
    let state = addBrowserTab(createBrowserTabs('tab-a'), createBrowserTab('tab-b'));
    state = addBrowserTab(state, createBrowserTab('tab-c'));
    const originalTabs = [...state.tabs];

    const reordered = reorderBrowserTabs(state, ['tab-c', 'tab-a', 'tab-b']);

    expect(reordered.activeId).toBe('tab-c');
    expect(reordered.tabs.map((tab) => tab.id)).toEqual(['tab-c', 'tab-a', 'tab-b']);
    expect(reordered.tabs).toEqual([originalTabs[2], originalTabs[0], originalTabs[1]]);
    expect(reordered.tabs[0]).toBe(originalTabs[2]);
  });

  it('ignores invalid tab reorder permutations', () => {
    const state = addBrowserTab(createBrowserTabs('tab-a'), createBrowserTab('tab-b'));
    expect(reorderBrowserTabs(state, ['tab-a'])).toBe(state);
    expect(reorderBrowserTabs(state, ['tab-a', 'tab-a'])).toBe(state);
    expect(reorderBrowserTabs(state, ['tab-a', 'tab-c'])).toBe(state);
  });

  it('selects an adjacent tab after close and replaces the final tab with blank', () => {
    let state = addBrowserTab(createBrowserTabs('tab-a'), createBrowserTab('tab-b'));
    state = addBrowserTab(state, createBrowserTab('tab-c'));
    state = selectBrowserTab(state, 'tab-b');
    state = closeBrowserTab(state, 'tab-b', createBrowserTab('unused'));
    expect(state.activeId).toBe('tab-c');
    expect(state.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'tab-c']);

    state = closeBrowserTab(selectBrowserTab(state, 'tab-a'), 'tab-a', createBrowserTab('unused-2'));
    expect(state.activeId).toBe('tab-c');
    state = closeBrowserTab(state, 'tab-c', createBrowserTab('tab-new'));
    expect(state).toEqual(createBrowserTabs('tab-new'));
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

  it('names the cause and does not blame the pane', () => {
    expect(FRAME_REFUSED_HINT).toMatch(/X-Frame-Options/);
  });
});
