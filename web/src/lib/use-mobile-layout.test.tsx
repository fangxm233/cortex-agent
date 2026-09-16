import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANG_STORAGE_KEY } from '@/i18n/lang';
import { LangProvider, useIsMobile, useLang } from '@/i18n/LangProvider';
import { MOBILE_LAYOUT_QUERY, useMobileLayout } from './use-mobile-layout';

// The suite runs in the vitest Node environment (no jsdom). Native shell flags live on
// `globalThis` (desktop-config) and the browser API is stubbed as `window` per case, exactly like
// desktop-config.test.ts / LangServerSync.test.tsx.
type FlagGlobal = typeof globalThis & {
  __CORTEX_MOBILE__?: boolean;
  __CORTEX_DESKTOP__?: boolean;
};

interface FakeViewport {
  window: { matchMedia: (query: string) => MediaQueryList };
  matchMedia: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listenerCount: () => number;
  setWidth: (width: number) => void;
}

/**
 * A `matchMedia` whose `(max-width: 767px)` query is driven by an explicit width, so the test can
 * cross the breakpoint in either direction. `setWidth` fires the registered `change` listeners the
 * way a real browser would.
 */
function fakeViewport(initialWidth: number): FakeViewport {
  let matches = initialWidth <= 767;
  const listeners = new Set<() => void>();
  const addEventListener = vi.fn((_type: string, listener: () => void) => { listeners.add(listener); });
  const removeEventListener = vi.fn((_type: string, listener: () => void) => { listeners.delete(listener); });
  const query = {
    get matches() { return matches; },
    media: MOBILE_LAYOUT_QUERY,
    addEventListener,
    removeEventListener,
  } as unknown as MediaQueryList;
  const matchMedia = vi.fn((_query: string) => query);
  return {
    window: { matchMedia },
    matchMedia,
    addEventListener,
    removeEventListener,
    listenerCount: () => listeners.size,
    setWidth(width: number) {
      matches = width <= 767;
      for (const listener of [...listeners]) listener();
    },
  };
}

let layout: boolean | null = null;

function LayoutProbe() {
  layout = useMobileLayout();
  return null;
}

const renderers = new Set<ReactTestRenderer>();

function mount(element: ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(element); });
  renderers.add(renderer);
  return renderer;
}

beforeEach(() => {
  layout = null;
});

afterEach(() => {
  act(() => { for (const renderer of renderers) renderer.unmount(); });
  renderers.clear();
  vi.unstubAllGlobals();
  delete (globalThis as FlagGlobal).__CORTEX_MOBILE__;
  delete (globalThis as FlagGlobal).__CORTEX_DESKTOP__;
});

describe('useMobileLayout — ordinary browser viewport', () => {
  it('reads matchMedia synchronously on the first render (no effect tick needed)', () => {
    const vp = fakeViewport(500);
    vi.stubGlobal('window', vp.window);

    mount(<LayoutProbe />);

    expect(layout).toBe(true);
    expect(vp.matchMedia).toHaveBeenCalledWith(MOBILE_LAYOUT_QUERY);
  });

  it('treats the 767px boundary as inclusive and 768px as desktop', () => {
    for (const [width, expected] of [[767, true], [768, false], [375, true], [1440, false]] as const) {
      const vp = fakeViewport(width);
      vi.stubGlobal('window', vp.window);
      const renderer = mount(<LayoutProbe />);

      expect(layout, `width ${width}`).toBe(expected);

      act(() => renderer.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('reacts to viewport changes in both directions', () => {
    const vp = fakeViewport(1024);
    vi.stubGlobal('window', vp.window);
    mount(<LayoutProbe />);
    expect(layout).toBe(false);

    act(() => vp.setWidth(600));
    expect(layout).toBe(true);

    act(() => vp.setWidth(1024));
    expect(layout).toBe(false);
  });

  it('supports legacy WebKit media query listeners', () => {
    let matches = false;
    let listener: (() => void) | undefined;
    const removeListener = vi.fn();
    vi.stubGlobal('window', { matchMedia: () => ({
      get matches() { return matches; },
      addListener: (fn: () => void) => { listener = fn; },
      removeListener,
    }) });
    const renderer = mount(<LayoutProbe />);
    expect(layout).toBe(false);
    act(() => { matches = true; listener!(); });
    expect(layout).toBe(true);
    act(() => renderer.unmount());
    expect(removeListener).toHaveBeenCalledWith(listener);
  });

  it('removes its change listener on unmount', () => {
    const vp = fakeViewport(1024);
    vi.stubGlobal('window', vp.window);
    const renderer = mount(<LayoutProbe />);

    expect(vp.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(vp.listenerCount()).toBe(1);

    act(() => renderer.unmount());

    expect(vp.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(vp.listenerCount()).toBe(0);
  });
});

describe('useMobileLayout — native shell flags win over the viewport', () => {
  it('native mobile is mobile even on a desktop-width viewport', () => {
    (globalThis as FlagGlobal).__CORTEX_MOBILE__ = true;
    vi.stubGlobal('window', fakeViewport(1440).window);

    mount(<LayoutProbe />);

    expect(layout).toBe(true);
  });

  it('native desktop is desktop even on a mobile-width viewport', () => {
    (globalThis as FlagGlobal).__CORTEX_DESKTOP__ = true;
    vi.stubGlobal('window', fakeViewport(375).window);

    mount(<LayoutProbe />);

    expect(layout).toBe(false);
  });

  it('native mobile is mobile with no browser APIs at all', () => {
    (globalThis as FlagGlobal).__CORTEX_MOBILE__ = true;

    mount(<LayoutProbe />);

    expect(layout).toBe(true);
  });

  it('native desktop is desktop with no browser APIs at all', () => {
    (globalThis as FlagGlobal).__CORTEX_DESKTOP__ = true;

    mount(<LayoutProbe />);

    expect(layout).toBe(false);
  });
});

describe('useMobileLayout — no browser API degrades to desktop', () => {
  it('no window', () => {
    mount(<LayoutProbe />);
    expect(layout).toBe(false);
  });

  it('window without matchMedia', () => {
    vi.stubGlobal('window', {});
    mount(<LayoutProbe />);
    expect(layout).toBe(false);
  });

  it('window with a non-function matchMedia', () => {
    vi.stubGlobal('window', { matchMedia: 'not-a-function' });
    mount(<LayoutProbe />);
    expect(layout).toBe(false);
  });

  it('matchMedia that throws does not break first paint', () => {
    vi.stubGlobal('window', {
      matchMedia: () => { throw new Error('denied'); },
    });

    expect(() => mount(<LayoutProbe />)).not.toThrow();
    expect(layout).toBe(false);
  });
});

// The layout hook is the value LangProvider exposes as useIsMobile; the language itself is a
// separate, server-owned knob and must not be derived from the viewport.
describe('LangProvider integration', () => {
  let app: { isMobile: boolean; lang: string } | null = null;

  function AppProbe() {
    app = { isMobile: useIsMobile(), lang: useLang() };
    return null;
  }

  function browserWindow(matchMedia: (query: string) => MediaQueryList, seedLang?: string) {
    const store = new Map<string, string>(seedLang ? [[LANG_STORAGE_KEY, seedLang]] : []);
    return {
      matchMedia,
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
    };
  }

  beforeEach(() => {
    app = null;
  });

  it('exposes the browser viewport as the layout without touching the language', () => {
    const vp = fakeViewport(375);
    vi.stubGlobal('window', browserWindow(vp.window.matchMedia, 'en'));
    const renderer = mount(<LangProvider><AppProbe /></LangProvider>);

    expect(app?.isMobile).toBe(true);
    // A narrow viewport selects the mobile LAYOUT only; the language stays whatever the
    // cache/server decided (here a cached 'en').
    expect(app?.lang).toBe('en');

    act(() => renderer.unmount());
  });

  it('updates the layout as the browser viewport crosses the breakpoint', () => {
    const vp = fakeViewport(1024);
    vi.stubGlobal('window', browserWindow(vp.window.matchMedia, 'en'));
    const renderer = mount(<LangProvider><AppProbe /></LangProvider>);

    expect(app?.isMobile).toBe(false);
    act(() => vp.setWidth(375));
    expect(app?.isMobile).toBe(true);
    expect(app?.lang).toBe('en');

    act(() => renderer.unmount());
  });
});
