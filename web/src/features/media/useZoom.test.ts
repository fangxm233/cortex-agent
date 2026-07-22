import { describe, it, expect } from 'vitest';
import { wheelShouldZoom } from './useZoom';

describe('wheelShouldZoom', () => {
  it('css-zoom (PDF): plain wheel scrolls, does NOT zoom', () => {
    expect(wheelShouldZoom('css-zoom', { ctrlKey: false, metaKey: false })).toBe(false);
  });

  it('css-zoom (PDF): zooms only while Ctrl or ⌘ is held (also matches trackpad pinch)', () => {
    expect(wheelShouldZoom('css-zoom', { ctrlKey: true, metaKey: false })).toBe(true);
    expect(wheelShouldZoom('css-zoom', { ctrlKey: false, metaKey: true })).toBe(true);
  });

  it('transform (image lightbox, no scroll container): wheel always zooms', () => {
    expect(wheelShouldZoom('transform', { ctrlKey: false, metaKey: false })).toBe(true);
    expect(wheelShouldZoom('transform', { ctrlKey: true, metaKey: false })).toBe(true);
  });
});
