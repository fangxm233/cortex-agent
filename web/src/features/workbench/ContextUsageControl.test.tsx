// input:  ContextUsageControl/Details with PI snapshots and language variants
// output: compact header bar/percentage and detail modal render regressions
// pos:    Shared context usage presentation contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextUsageControl, ContextUsageDetails } from './ContextUsageControl';

const usage = {
  usedTokens: 60000,
  contextWindow: 200000,
  percent: 30,
  accuracy: 'estimate' as const,
  updatedAt: '2026-07-27T12:00:00.000Z',
};

describe('ContextUsageControl', () => {
  it('renders only a short clickable progress bar and percentage on desktop', () => {
    const html = renderToStaticMarkup(
      <ContextUsageControl usage={usage} supported variant="desktop" lang="en" />,
    );
    expect(html).toContain('data-context-usage-bar="desktop"');
    expect(html).toContain('data-context-usage-track="desktop"');
    expect(html).toContain('width:64px');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain('>30%</span>');
    expect(html).not.toContain('60k / 200k');
    expect(html).not.toContain('>CONTEXT<');
    expect(html).not.toContain('border:1px solid var(--proto-line-3)');
  });

  it('renders an empty short mobile track without unavailable copy and hides unsupported empty sessions', () => {
    const pi = renderToStaticMarkup(
      <ContextUsageControl usage={null} supported variant="mobile" lang="zh" />,
    );
    expect(pi).toContain('data-context-usage-bar="mobile"');
    expect(pi).toContain('data-context-usage-track="mobile"');
    expect(pi).toContain('width:48px');
    expect(pi).toContain('>—</span>');
    expect(pi).not.toContain('暂不可用');
    expect(pi).not.toContain('— / —');

    const unsupported = renderToStaticMarkup(
      <ContextUsageControl usage={null} supported={false} variant="desktop" lang="en" />,
    );
    expect(unsupported).toBe('');
  });
});

describe('ContextUsageDetails', () => {
  it('shows full current and maximum token values plus PI estimate disclosure', () => {
    const html = renderToStaticMarkup(<ContextUsageDetails usage={usage} lang="en" />);
    expect(html).toContain('Current context');
    expect(html).toContain('60,000 tokens');
    expect(html).toContain('Context limit');
    expect(html).toContain('200,000 tokens');
    expect(html).toContain('PI reports this value as an estimate');
  });

  it('explains when the first PI snapshot is not available yet', () => {
    const html = renderToStaticMarkup(<ContextUsageDetails usage={null} lang="zh" />);
    expect(html).toContain('当前上下文');
    expect(html).toContain('下一次 PI turn 完成后');
  });
});
