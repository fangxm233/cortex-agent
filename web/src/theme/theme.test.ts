// input:  theme resolution and system media-query watcher
// output: Regression coverage for stored and system-following themes
// pos:    Unit tests for color-theme preference utilities
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME,
  applyTheme,
  resolveEffectiveTheme,
  resolveInitialTheme,
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
