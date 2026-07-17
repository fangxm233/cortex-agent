import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanReadOverlay } from './PlanReadOverlay';
import { D_INT_COPY } from './InteractionCards';
import { planCardModel } from './interaction-vm';
import type { TranscriptInteractionDetail } from '@cortex-agent/ui-contract';

// Desktop plan reading overlay — the 13c 阅读 › target. The desktop scheme draws no reading
// page (13c: 「全文在阅读页看」, mobile 6b defines it) → this is the 6b structure ported to
// desktop chrome, flagged as an honest addition. Neutral fixtures.

const copy = D_INT_COPY.zh;
const noop = (): void => {};

const detail = (status: TranscriptInteractionDetail['status']): TranscriptInteractionDetail => ({
  id: 'req-plan-1',
  kind: 'plan-approval',
  status,
  payload: { planContent: '# 2×4 消融矩阵\n\n## 目标\n\n验证 friction/mass 随机化。', planFilePath: 'plans/plan-ablation.md' },
});

describe('PlanReadOverlay', () => {
  it('pending: header meta + rendered markdown + resident approve/request-changes bar', () => {
    const html = renderToStaticMarkup(
      <PlanReadOverlay model={planCardModel(detail('pending'), '2026-07-16T07:38:00Z')} copy={copy} onClose={noop} onApprove={noop} onRequestChanges={noop} />,
    );
    expect(html).toContain('2×4 消融矩阵');
    expect(html).toContain('plans/plan-ablation.md · 5 行 · 待批');
    expect(html).toContain('目标');
    expect(html).not.toContain('## 目标'); // markdown rendered, not raw
    expect(html).toContain('批准计划');
    expect(html).toContain('请求修改');
  });
  it('sealed: read-only status stamp, no action buttons', () => {
    const html = renderToStaticMarkup(
      <PlanReadOverlay model={planCardModel(detail('approved'), '2026-07-16T07:41:00Z')} copy={copy} onClose={noop} onApprove={noop} onRequestChanges={noop} />,
    );
    expect(html).toContain('✓ 计划已批准');
    expect(html).not.toContain('批准计划');
    expect(html).not.toContain('请求修改');
  });
});
