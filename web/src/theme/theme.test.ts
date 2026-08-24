// input:  theme/accent persistence, DOM application, system watcher
// output: Regression coverage for device-local appearance preferences
// pos:    Unit tests for appearance preference utilities
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME,
  applyAccentHue,
  applyTheme,
  parseStoredAccentHue,
  readStoredAccentHue,
  resolveEffectiveTheme,
  resolveInitialTheme,
  storeAccentHue,
  watchSystemTheme,
} from './theme';

afterEach(() => vi.unstubAllGlobals());

describe('resolveInitialTheme', () => {
  it('honors a valid stored choice over the OS preference', () => {
    expect(resolveInitialTheme('dark', false)).toBe('dark');
    expect(resolveInitialTheme('light', true)).toBe('light');
    expect(resolveInitialTheme('system', false)).toBe('system');
  });

  it('falls back to the OS prefers-color-scheme when nothing is stored', () => {
    expect(resolveInitialTheme(null, true)).toBe('dark');
    expect(resolveInitialTheme(null, false)).toBe('light');
  });

  it('falls back to the default for an unset/garbage stored value with no OS hint', () => {
    expect(resolveInitialTheme(null)).toBe(DEFAULT_THEME);
    expect(resolveInitialTheme('purple', false)).toBe(DEFAULT_THEME);
  });
});

describe('resolveEffectiveTheme', () => {
  it('resolves system while preserving explicit choices', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
    expect(resolveEffectiveTheme('light', true)).toBe('light');
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('syncs the document theme and browser chrome token', () => {
    const setRootAttribute = vi.fn();
    const setMetaAttribute = vi.fn();
    vi.stubGlobal('document', {
      documentElement: { setAttribute: setRootAttribute, removeAttribute: vi.fn(), style: {} },
      querySelector: vi.fn(() => ({ setAttribute: setMetaAttribute })),
    });
    vi.stubGlobal('getComputedStyle', vi.fn(() => ({
      getPropertyValue: () => '#12151a',
    })));

    applyTheme('dark', false);

    expect(setRootAttribute).toHaveBeenCalledWith('data-theme', 'dark');
    expect(setMetaAttribute).toHaveBeenCalledWith('content', '#12151a');
  });
});

describe('accent hue', () => {
  it('accepts only persisted integer hues in range', () => {
    expect(parseStoredAccentHue('0')).toBe(0);
    expect(parseStoredAccentHue('359')).toBe(359);
    for (const invalid of [null, '', '-1', '360', '12.5', 'blue']) {
      expect(parseStoredAccentHue(invalid)).toBeNull();
    }
  });

  it('reads, writes, and removes the device-local preference', () => {
    const getItem = vi.fn(() => '305');
    const setItem = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal('window', { localStorage: { getItem, setItem, removeItem } });

    expect(readStoredAccentHue()).toBe(305);
    storeAccentHue(190);
    storeAccentHue(null);

    expect(getItem).toHaveBeenCalledWith('cortex.accent-hue');
    expect(setItem).toHaveBeenCalledWith('cortex.accent-hue', '190');
    expect(removeItem).toHaveBeenCalledWith('cortex.accent-hue');
  });

  it('applies and resets the custom accent on the document root', () => {
    const setAttribute = vi.fn();
    const removeAttribute = vi.fn();
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    vi.stubGlobal('document', {
      documentElement: {
        setAttribute,
        removeAttribute,
        style: { setProperty, removeProperty },
      },
      querySelector: vi.fn(() => null),
    });
    vi.stubGlobal('getComputedStyle', vi.fn(() => ({ getPropertyValue: () => '' })));

    applyAccentHue(190);
    expect(setAttribute).toHaveBeenCalledWith('data-accent', 'custom');
    expect(setProperty).toHaveBeenCalledWith('--accent-hue', '190');

    applyAccentHue(null);
    expect(removeAttribute).toHaveBeenCalledWith('data-accent');
    expect(removeProperty).toHaveBeenCalledWith('--accent-hue');
  });
});

describe('watchSystemTheme', () => {
  it('forwards system changes and removes its listener on cleanup', () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    const addEventListener = vi.fn(
      (_type: string, next: (event: MediaQueryListEvent) => void) => { listener = next; },
    );
    const removeEventListener = vi.fn();
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ addEventListener, removeEventListener })),
    });
    const onChange = vi.fn();

    const cleanup = watchSystemTheme(onChange);
    listener?.({ matches: true } as MediaQueryListEvent);
    cleanup();

    expect(onChange).toHaveBeenCalledWith(true);
    expect(removeEventListener).toHaveBeenCalledWith('change', listener);
  });
});
