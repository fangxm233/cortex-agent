import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextUsageRing, contextWedgePath } from './ContextUsageControl';

const usage = (percent: number) => ({ usedTokens: 1, contextWindow: 100, percent, accuracy: 'exact' as const, updatedAt: '' });

describe('context usage gauge', () => {
  it('fills a wedge from twelve o’clock, clockwise, and nothing when empty', () => {
    expect(contextWedgePath(null, 10, 6)).toBeNull();
    expect(contextWedgePath(0, 10, 6)).toBeNull();
    // A quarter ends at three o'clock on the small arc.
    expect(contextWedgePath(25, 10, 6)).toBe('M 10 10 L 10 4.00 A 6 6 0 0 1 16.00 10.00 Z');
    // Past half the arc takes the long way round.
    expect(contextWedgePath(75, 10, 6)).toContain(' 0 1 1 ');
    // Full (or over-full) is the whole disc.
    expect(contextWedgePath(100, 10, 6)).toBe(contextWedgePath(130, 10, 6));
    expect(contextWedgePath(100, 10, 6)).not.toContain('L');
  });

  it('draws a filled share, not a stroked arc that reads as a spinner, and keeps its label', () => {
    const html = renderToStaticMarkup(<ContextUsageRing usage={usage(38)} variant="mobile" />);
    expect(html).toContain('data-context-usage-wedge=""');
    expect(html).toMatch(/<path[^>]*fill="var\(--proto-muted\)"/);
    expect(html).not.toContain('stroke-dasharray');
    expect(html).toContain('aria-valuenow="38"');
    expect(html).toMatch(/aria-label="[^"]*38%"/);
    expect(renderToStaticMarkup(<ContextUsageRing usage={null} variant="desktop" />)).not.toContain('data-context-usage-wedge');
  });
});
