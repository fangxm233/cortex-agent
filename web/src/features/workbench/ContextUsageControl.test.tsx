// input:  context bar/modal and manual compact action states
// output: shared bar, desktop modal, and compact action regressions
// pos:    Shared context usage presentation contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ContextCompactFooter,
  ContextUsageBar,
  ContextUsageControl,
  ContextUsageDetails,
  type ContextCompactAction,
} from './ContextUsageControl';

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

  it('renders an empty mobile bar as a direct sheet trigger and hides unsupported empty sessions', () => {
    const pi = renderToStaticMarkup(
      <ContextUsageBar usage={null} variant="mobile" lang="zh" />,
    );
    expect(pi).toContain('data-context-usage-bar="mobile"');
    expect(pi).toContain('data-context-usage-track="mobile"');
    expect(pi).toContain('data-context-usage-presentation="sheet-trigger"');
    expect(pi).toContain('width:48px');
    expect(pi).toContain('>—</span>');
    expect(pi).not.toContain('aria-haspopup="dialog"');
    expect(pi).not.toContain('暂不可用');
    expect(pi).not.toContain('— / —');

    const unsupported = renderToStaticMarkup(
      <ContextUsageControl usage={null} supported={false} variant="desktop" lang="en" />,
    );
    expect(unsupported).toBe('');
  });
});

describe('ContextUsageDetails', () => {
  it('shows full values plus a backend-neutral estimate disclosure', () => {
    const html = renderToStaticMarkup(<ContextUsageDetails usage={usage} lang="en" />);
    expect(html).toContain('Current context');
    expect(html).toContain('60,000 tokens');
    expect(html).toContain('Context limit');
    expect(html).toContain('200,000 tokens');
    expect(html).toContain('The backend reports this value as an estimate');
  });

  it('explains when the first snapshot is not available yet', () => {
    const html = renderToStaticMarkup(<ContextUsageDetails usage={null} lang="zh" />);
    expect(html).toContain('当前上下文');
    expect(html).toContain('下一次 turn 完成后');
  });
});

describe('ContextCompactFooter', () => {
  const action: ContextCompactAction = {
    onCompact: () => {}, pending: false, disabled: false,
    status: null, error: null, disabledReason: null,
  };

  it('renders the idle action as Compact in English and 压缩 in Chinese', () => {
    const english = renderToStaticMarkup(<ContextCompactFooter action={action} lang="en" />);
    expect(english).toContain('data-context-compact-action');
    expect(english).toContain('>Compact</button>');
    expect(english).not.toContain('disabled=""');

    const chinese = renderToStaticMarkup(<ContextCompactFooter action={action} lang="zh" />);
    expect(chinese).toContain('>压缩</button>');
  });

  it('disables the action while pending or session-running and explains why', () => {
    const pending = renderToStaticMarkup(
      <ContextCompactFooter action={{ ...action, pending: true }} lang="en" />,
    );
    expect(pending).toContain('Compacting…');
    expect(pending).toContain('disabled');

    const running = renderToStaticMarkup(
      <ContextCompactFooter action={{ ...action, disabled: true, disabledReason: 'running' }} lang="zh" />,
    );
    expect(running).toContain('请先停止当前 turn');
    expect(running).toContain('disabled');
  });

  it('announces compacted, not-needed, and server error outcomes in the modal', () => {
    const compacted = renderToStaticMarkup(
      <ContextCompactFooter action={{ ...action, status: 'compacted' }} lang="en" />,
    );
    expect(compacted).toContain('Context compacted');
    expect(compacted).toContain('aria-live="polite"');

    const noop = renderToStaticMarkup(
      <ContextCompactFooter action={{ ...action, status: 'not-needed' }} lang="en" />,
    );
    expect(noop).toContain('Nothing to compact');

    const failed = renderToStaticMarkup(
      <ContextCompactFooter action={{ ...action, error: 'backend unavailable' }} lang="en" />,
    );
    expect(failed).toContain('backend unavailable');
  });
});
