import { afterEach, describe, it, expect, vi } from 'vitest';
import { readStoredLang, resolveInitialLang, storeLang } from './lang';

// The cache is a FIRST-PAINT guess only: the server's value (config.get → lang) overwrites it as
// soon as it lands. See LangServerSync.test.tsx for that half.
describe('resolveInitialLang (cache → browser → default)', () => {
  it('prefers a cached choice', () => {
    expect(resolveInitialLang('zh')).toBe('zh');
    expect(resolveInitialLang('en', 'zh-CN')).toBe('en');
  });

  it('falls back to the browser preference, then to English', () => {
    expect(resolveInitialLang(null, 'zh-CN')).toBe('zh');
    expect(resolveInitialLang(null, 'fr-FR')).toBe('en');
    expect(resolveInitialLang('klingon')).toBe('en');
    expect(resolveInitialLang(null)).toBe('en');
  });
});

describe('the language cache', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips through local storage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
    });
    storeLang('zh');
    expect(readStoredLang()).toBe('zh');
  });

  it('survives a storage that throws (private mode) instead of breaking first paint', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('denied'); },
        setItem: () => { throw new Error('denied'); },
      },
    });
    expect(() => storeLang('zh')).not.toThrow();
    expect(readStoredLang()).toBe('en');
  });
});
