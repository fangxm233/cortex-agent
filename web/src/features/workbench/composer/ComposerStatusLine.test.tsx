import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ComposerStatusLine } from './ComposerStatusLine';

describe('ComposerStatusLine', () => {
  const statusText = (renderer: ReactTestRenderer): string =>
    renderer.root.findAllByType('span').map((span) => span.children.filter((c) => typeof c === 'string').join('')).join('');

  it('renders the settled text when no clock runs', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<ComposerStatusLine running={false} text="idle · 4m 2s" />); });
    expect(statusText(renderer)).toBe('idle · 4m 2s');
  });

  it('ticks a running turn clock every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(
          <ComposerStatusLine running text="settled" liveText={(now) => `running · ${(now - 1_000_000) / 1000}s`} />,
        );
      });
      expect(statusText(renderer)).toBe('running · 0s');
      act(() => { vi.advanceTimersByTime(2000); });
      expect(statusText(renderer)).toBe('running · 2s');
      act(() => renderer.unmount());
    } finally {
      vi.useRealTimers();
    }
  });
});
