// input:  mounted LangProvider + LangServerSync over a mocked config.get/config.set pair
// output: server-adopts-over-cache, write-through on toggle, and offline-degradation regressions
// pos:    Specification for "the language is one server setting, not a per-device preference"
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConfigSnapshot } from '@cortex-agent/ui-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider, LangServerSync, useLang, useLangSource, useSetLang, type Lang, type LangSource } from '@/i18n';
import { LANG_STORAGE_KEY } from './lang';

const adapter = vi.hoisted(() => ({ config: vi.fn(), set: vi.fn() }));

// The suite runs in node, so there is no DOM: stub the one browser API the cache uses. `window`
// must exist BEFORE LangProvider's lazy initial state runs, i.e. before every mount.
function fakeStorage(seed?: Lang) {
  const store = new Map<string, string>(seed ? [[LANG_STORAGE_KEY, seed]] : []);
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

function cacheLang(seed?: Lang) {
  const localStorage = fakeStorage(seed);
  vi.stubGlobal('window', { localStorage });
  return localStorage;
}

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    config: {
      get: {
        queryOptions: (input: unknown) => ({ queryKey: ['config.get', input], queryFn: () => adapter.config(input) }),
        queryFilter: (input: unknown) => ({ queryKey: ['config.get', input] }),
      },
      set: { mutationOptions: (options: object) => ({
        ...options, mutationFn: (input: unknown) => adapter.set(input),
      }) },
    },
  }),
}));

function snapshot(lang?: { value: Lang; source: 'env' | 'file' | 'default' }): ConfigSnapshot {
  return {
    budget: null, profiles: null, machines: [], mcp: null,
    threadTemplates: { agents: [], templates: [], shells: [] },
    hooks: [], env: [], settings: [], ...(lang ? { lang } : {}),
  } as unknown as ConfigSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let seen: { lang: Lang; source: LangSource; setLang: (l: Lang) => void } | null = null;

function Probe() {
  seen = { lang: useLang(), source: useLangSource(), setLang: useSetLang() };
  return null;
}

async function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={queryClient}>
        <LangProvider><LangServerSync /><Probe /></LangProvider>
      </QueryClientProvider>,
    );
  });
  return { queryClient, renderer };
}

beforeEach(() => {
  seen = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  adapter.set.mockResolvedValue({ written: true, section: 'preferences' });
});

// The `window` stub lives on the worker's globalThis, which outlives this file — leaving it in
// place lets a later suite in the same worker see a fake DOM it never asked for.
afterEach(() => vi.unstubAllGlobals());

describe('the language is the server\'s, not the device\'s', () => {
  it('adopts the server language over a conflicting local cache', async () => {
    const cache = cacheLang('en');
    adapter.config.mockResolvedValue(snapshot({ value: 'zh', source: 'file' }));

    await mount();

    await vi.waitFor(() => expect(seen?.lang).toBe('zh'));
    expect(seen?.source).toBe('file');
    // the cache is rewritten so the next first paint no longer flashes the stale choice
    expect(cache.getItem(LANG_STORAGE_KEY)).toBe('zh');
  });

  it('reports env provenance so the UI can warn that CORTEX_LANG wins at boot', async () => {
    cacheLang();
    adapter.config.mockResolvedValue(snapshot({ value: 'zh', source: 'env' }));
    await mount();
    await vi.waitFor(() => expect(seen?.source).toBe('env'));
  });

  it('flips immediately and writes the change back — this is what switches the conversation too', async () => {
    cacheLang('zh');
    adapter.config.mockResolvedValue(snapshot({ value: 'zh', source: 'file' }));
    const write = deferred<unknown>();
    adapter.set.mockReturnValue(write.promise);
    await mount();
    // Wait for the SERVER value to land, not just the cached one: `source` only leaves 'cache'
    // once config.get has been adopted, and toggling before that would race the first adopt.
    await vi.waitFor(() => expect(seen?.source).toBe('file'));

    await act(async () => { seen?.setLang('en'); });

    // optimistic: the UI does not wait for the round trip...
    expect(seen?.lang).toBe('en');
    // ...and the write goes through the one config section that also flips the server locale
    expect(adapter.set).toHaveBeenCalledWith({ section: 'preferences', value: { lang: 'en' } });

    // the server switched, so its snapshot now agrees and the post-write refetch keeps 'en'
    adapter.config.mockResolvedValue(snapshot({ value: 'en', source: 'file' }));
    await act(async () => { write.resolve({ written: true, section: 'preferences' }); });
    await vi.waitFor(() => expect(seen?.lang).toBe('en'));
  });

  it('rolls back to the server value when the write fails', async () => {
    cacheLang('zh');
    adapter.config.mockResolvedValue(snapshot({ value: 'zh', source: 'file' }));
    adapter.set.mockRejectedValue(new Error('read-only config'));
    await mount();
    await vi.waitFor(() => expect(seen?.source).toBe('file'));

    await act(async () => { seen?.setLang('en'); });

    // the optimistic flip is undone by the refetch: the server never changed, so neither does the UI
    await vi.waitFor(() => expect(seen?.lang).toBe('zh'));
  });

  it('keeps the cached language when the server cannot be reached', async () => {
    cacheLang('zh');
    adapter.config.mockRejectedValue(new Error('offline'));

    await mount();

    await vi.waitFor(() => expect(adapter.config).toHaveBeenCalled());
    await act(async () => {});
    expect(seen?.lang).toBe('zh');
    expect(seen?.source).toBe('cache');
  });

  it('leaves the cached language alone when an older server omits lang', async () => {
    cacheLang('zh');
    adapter.config.mockResolvedValue(snapshot());

    await mount();

    await vi.waitFor(() => expect(adapter.config).toHaveBeenCalled());
    await act(async () => {});
    expect(seen?.lang).toBe('zh');
    expect(seen?.source).toBe('cache');
  });
});
