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

  it('sets the session totals at the far end, in the UI face, with no divider glyph', () => {
    const open = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ComposerStatusLine running text="running · 1m 12s" sessionText="session 9m · $0.96" onOpenSessionStats={open} />,
      );
    });
    const line = renderer.root.findByProps({ 'data-composer-status-line': 'true' });
    expect(line.props.style.font).toContain('var(--font-ui)');
    expect(statusText(renderer)).toBe('running · 1m 12s' + 'session 9m · $0.96');
    expect(statusText(renderer)).not.toContain('│');
    expect(renderer.root.findByProps({ 'data-composer-status-dot': 'running' }).props.style.background).toBe('var(--proto-accent)');
    const totals = renderer.root.findByProps({ 'data-composer-session-totals': 'true' });
    expect(totals.props.style.marginLeft).toBe('auto');
    act(() => totals.props.onClick());
    act(() => totals.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }));
    expect(open).toHaveBeenCalledTimes(2);
  });
});
