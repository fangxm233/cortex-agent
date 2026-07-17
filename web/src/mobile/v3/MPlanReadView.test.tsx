import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MPlanReadView, M_PLAN_READ_COPY } from './MPlanReadView';
import { planCardModel } from '@/features/workbench/interaction-vm';
import type { TranscriptInteractionDetail } from '@cortex-agent/ui-contract';

// 6b 计划全文阅读页 (scheme-mobile sec-6 L132-167). Neutral fixtures.

const copy = M_PLAN_READ_COPY.zh;
const noop = (): void => {};

const detail = (status: TranscriptInteractionDetail['status'], feedback?: string): TranscriptInteractionDetail => ({
  id: 'req-plan-1',
  kind: 'plan-approval',
  status,
  payload: { planContent: '# DR 扫描计划\n\n## 目标\n\n验证 friction 收窄后抖动是否消失。', planFilePath: 'plans/EXP-024-plan.md' },
  ...(feedback ? { result: { feedback } } : {}),
});

describe('MPlanReadView — 6b pending', () => {
  const html = renderToStaticMarkup(
    <MPlanReadView model={planCardModel(detail('pending'), '2026-07-16T07:38:00Z')} copy={copy} onBack={noop} onApprove={noop} onReject={noop} />,
  );
  it('renders header title + meta (path · REAL line count · 待批) + status pill + progress bar', () => {
    expect(html).toContain('DR 扫描计划');
    expect(html).toContain('plans/EXP-024-plan.md · 5 行 · 待批');
    expect(html).toContain('计划待批'); // header pill
    expect(html).toContain('#4655D4'); // progress bar fill
  });
  it('renders the plan markdown body (headings, not raw #)', () => {
    expect(html).toContain('目标');
    expect(html).toContain('验证 friction 收窄后抖动是否消失。');
    expect(html).not.toContain('## 目标');
  });
  it('renders the resident action bar: 批准并执行 + 驳回并反馈', () => {
    expect(html).toContain('批准并执行');
    expect(html).toContain('驳回并反馈');
  });
});

describe('MPlanReadView — sealed (read-only, status stamp bar)', () => {
  it('approved → 已批准 stamp, no action buttons', () => {
    const html = renderToStaticMarkup(
      <MPlanReadView model={planCardModel(detail('approved'), '2026-07-16T07:41:00Z')} copy={copy} onBack={noop} onApprove={noop} onReject={noop} />,
    );
    expect(html).toContain('✓ 计划已批准');
    expect(html).not.toContain('批准并执行');
    expect(html).not.toContain('驳回并反馈');
  });
  it('rejected → 已驳回 stamp with the real feedback line', () => {
    const html = renderToStaticMarkup(
      <MPlanReadView model={planCardModel(detail('rejected', 'friction 上限压到 1.0'), '2026-07-16T07:44:00Z')} copy={copy} onBack={noop} onApprove={noop} onReject={noop} />,
    );
    expect(html).toContain('已驳回');
    expect(html).toContain('friction 上限压到 1.0');
    expect(html).not.toContain('批准并执行');
  });
});
