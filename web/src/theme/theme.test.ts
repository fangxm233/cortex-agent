// input:  theme, palette, accent, motion persistence and DOM application
// output: Regression coverage for device-local appearance preferences
// pos:    Unit tests for appearance preference utilities
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME,
  applyAccentHue,
  applyAccentIntensity,
  applyMotionMode,
  applyTheme,
  parseStoredAccentHue,
  parseStoredAccentIntensity,
  parseStoredMotionMode,
  readStoredAccentHue,
  resolveEffectiveTheme,
  resolveInitialTheme,
  storeAccentHue,
  watchSystemTheme,
} from './theme';
import {
  DEFAULT_PALETTE,
  applyPalette,
  parseStoredPalette,
  readStoredPalette,
  storePalette,
} from './palette';

/** Stubs a document root that records attribute writes, for the `apply*` helpers. */
function stubRoot() {
  const setAttribute = vi.fn();
  const removeAttribute = vi.fn();
  const setProperty = vi.fn();
  const removeProperty = vi.fn();
  vi.stubGlobal('document', {
    documentElement: { setAttribute, removeAttribute, style: { setProperty, removeProperty } },
    querySelector: vi.fn(() => null),
  });
  return { setAttribute, removeAttribute, setProperty, removeProperty };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
  it('animates a changed theme and syncs the browser chrome token', () => {
    vi.useFakeTimers();
    const setRootAttribute = vi.fn();
    const removeRootAttribute = vi.fn();
    const setMetaAttribute = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('document', {
      documentElement: {
        getAttribute: vi.fn(() => null),
        setAttribute: setRootAttribute,
        removeAttribute: removeRootAttribute,
        style: {},
        appendChild: vi.fn(),
      },
      querySelector: vi.fn(() => ({ setAttribute: setMetaAttribute })),
      createElement: vi.fn(() => ({ style: {}, remove })),
    });
    vi.stubGlobal('getComputedStyle', vi.fn(() => ({ color: 'rgb(18, 21, 26)' })));

    applyTheme('dark', false);

    expect(setRootAttribute).toHaveBeenCalledWith('data-theme-transition', '');
    expect(setRootAttribute).toHaveBeenCalledWith('data-theme', 'dark');
    expect(setMetaAttribute).toHaveBeenCalledWith('content', '#12151a');
    expect(remove).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(200);
    expect(removeRootAttribute).toHaveBeenCalledWith('data-theme-transition');
  });

  it('does not animate when the effective theme is unchanged', () => {
    const setRootAttribute = vi.fn();
    vi.stubGlobal('document', {
      documentElement: {
        getAttribute: vi.fn(() => 'dark'),
        setAttribute: setRootAttribute,
        removeAttribute: vi.fn(),
        style: {},
        appendChild: vi.fn(),
      },
      querySelector: vi.fn(() => null),
    });

    applyTheme('dark', false);

    expect(setRootAttribute).not.toHaveBeenCalledWith('data-theme-transition', '');
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

describe('palette', () => {
  it('parses a complete in-range palette and clamps invalid fields', () => {
    const parsed = parseStoredPalette(JSON.stringify({
      bgHue: 400, bgChroma: -1, bgLight: -0.123,
      inkHue: 42, inkChroma: 2.5, inkContrast: 0.2,
    }));

    expect(parsed).toEqual({
      bgHue: 359, bgChroma: 0, bgLight: -0.125,
      inkHue: 42, inkChroma: 2.5, inkContrast: 0.06,
    });
    expect(parseStoredPalette('{bad json')).toEqual(DEFAULT_PALETTE);
  });

  it('reads, writes, and removes the device-local palette', () => {
    const custom = { ...DEFAULT_PALETTE, bgHue: 120 };
    const getItem = vi.fn(() => JSON.stringify(custom));
    const setItem = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal('window', { localStorage: { getItem, setItem, removeItem } });

    expect(readStoredPalette()).toEqual(custom);
    storePalette(custom);
    storePalette(DEFAULT_PALETTE);

    expect(getItem).toHaveBeenCalledWith('cortex.palette');
    expect(setItem).toHaveBeenCalledWith('cortex.palette', JSON.stringify(custom));
    expect(removeItem).toHaveBeenCalledWith('cortex.palette');
  });

  it('writes custom CSS parameters and clears defaults', () => {
    const { setProperty, removeProperty } = stubRoot();

    applyPalette({ ...DEFAULT_PALETTE, bgHue: 120, inkContrast: 0.02 });

    expect(setProperty).toHaveBeenCalledWith('--bg-hue', '120');
    expect(setProperty).toHaveBeenCalledWith('--ink-contrast', '0.02');
    expect(removeProperty).toHaveBeenCalledWith('--bg-chroma');
  });
});

describe('accent intensity', () => {
  it('falls back to normal for anything outside the known levels', () => {
    expect(parseStoredAccentIntensity('soft')).toBe('soft');
    expect(parseStoredAccentIntensity('vivid')).toBe('vivid');
    for (const invalid of [null, '', 'loud']) {
      expect(parseStoredAccentIntensity(invalid)).toBe('normal');
    }
  });

  it('applies and clears the document attribute', () => {
    const { setAttribute, removeAttribute } = stubRoot();

    applyAccentIntensity('vivid');
    expect(setAttribute).toHaveBeenCalledWith('data-accent-intensity', 'vivid');

    applyAccentIntensity('normal');
    expect(removeAttribute).toHaveBeenCalledWith('data-accent-intensity');
  });
});

describe('motion mode', () => {
  it('falls back to system for anything outside the known modes', () => {
    expect(parseStoredMotionMode('reduced')).toBe('reduced');
    expect(parseStoredMotionMode('full')).toBe('full');
    for (const invalid of [null, '', 'none']) {
      expect(parseStoredMotionMode(invalid)).toBe('system');
    }
  });

  // `system` leaves the attribute off so the prefers-reduced-motion media rule governs.
  it('applies explicit modes and clears the attribute for system', () => {
    const { setAttribute, removeAttribute } = stubRoot();

    applyMotionMode('reduced');
    expect(setAttribute).toHaveBeenCalledWith('data-motion', 'reduced');

    applyMotionMode('system');
    expect(removeAttribute).toHaveBeenCalledWith('data-motion');
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
