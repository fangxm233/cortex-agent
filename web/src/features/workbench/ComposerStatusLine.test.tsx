// input:  ComposerStatusLine, compact ContextUsageControl, status fixtures
// output: desktop composer status/accessory placement regressions
// pos:    Verifies right-aligned context usage beside idle/running state
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextUsageControl } from './ContextUsageControl';
import { ComposerStatusLine } from './ComposerStatusLine';

const usage = {
  usedTokens: 60000,
  contextWindow: 200000,
  percent: 30,
  accuracy: 'estimate' as const,
  updatedAt: '2026-07-27T12:00:00.000Z',
};

describe('ComposerStatusLine', () => {
  it('right-aligns compact context usage beside the full idle status', () => {
    const html = renderToStaticMarkup(
      <ComposerStatusLine
        running={false}
        text="idle · 11m 41s · 46 turns · $4.20"
        accessory={<ContextUsageControl usage={usage} supported variant="desktop" lang="en" />}
      />,
    );
    expect(html).toContain('data-composer-status-line="true"');
    expect(html).toContain('idle · 11m 41s · 46 turns · $4.20');
    expect(html).toContain('data-context-usage-position="composer-status"');
    expect(html).toContain('margin-left:auto');
    expect(html).toContain('data-context-usage-bar="desktop"');
  });

  it('preserves the pulsing running indicator without an accessory', () => {
    const html = renderToStaticMarkup(
      <ComposerStatusLine running text="Running · 12s · 3 turns" />,
    );
    expect(html).toContain('Running · 12s · 3 turns');
    expect(html).toContain('cxpulse');
    expect(html).not.toContain('data-context-usage-position');
  });
});
