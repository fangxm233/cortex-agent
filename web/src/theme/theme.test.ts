import { describe, it, expect } from 'vitest';
import { resolveInitialTheme, DEFAULT_THEME } from './theme';

describe('resolveInitialTheme', () => {
  it('honors a valid stored choice over the OS preference', () => {
    expect(resolveInitialTheme('dark', false)).toBe('dark');
    expect(resolveInitialTheme('light', true)).toBe('light');
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
