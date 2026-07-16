import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { MApprovalsView, type MApprovalsCopy } from './MApprovalsView';
import { buildMApprovalsVm } from './m-approvals-vm';

const copy: MApprovalsCopy = {
  title: '审批',
  toProcess: '待处理',
  tier: '审批',
  from: '来自',
  paused: '线程已暂停等待',
  approve: '批准',
  reject: '拒绝并反馈',
  seeDiff: '点开看 diff ›',
  empty: '没有待处理的审批',
};

function apr(over: Partial<ApprovalInfo>): ApprovalInfo {
  return {
    id: 'apr-a',
    title: '超预算 dispatch — 8×A100 消融扫描',
    operation: '超预算',
    reason: '预估 $12.40 超过日预算 $10.00',
    impact: null,
    command: null,
    status: 'pending',
    queuedAt: '2026-07-15T11:48:00Z',
    decidedAt: null,
    feedback: null,
    provenance: 'ablation-sweep › dispatch',
    taskRef: null,
    ...over,
  };
}

function render(entries: ApprovalInfo[], expandedId?: string) {
  const now = Date.parse('2026-07-15T12:00:00Z');
  const vm = buildMApprovalsVm(entries, now);
  return renderToStaticMarkup(
    <MApprovalsView
      vm={vm}
      copy={copy}
      expandedId={expandedId ?? vm.cards[0]?.id ?? null}
      busy={false}
      onBack={() => {}}
      onExpand={() => {}}
      onApprove={() => {}}
      onReject={() => {}}
    />,
  );
}

describe('MApprovalsView', () => {
  it('renders the header: title, N 待处理 pill, and the file tag', () => {
    const html = render([apr({})]);
    expect(html).toContain('审批');
    expect(html).toContain('1 待处理');
    expect(html).toContain('PENDING_APPROVALS.md');
  });

  it('renders the expanded first card with real operation tier, reason, provenance, and the two 44px buttons', () => {
    const html = render([apr({})]);
    expect(html).toContain('审批 · 超预算'); // tier = static label · real operation
    expect(html).toContain('超预算 dispatch — 8×A100 消融扫描'); // real title
    expect(html).toContain('预估 $12.40 超过日预算 $10.00'); // real reason free-text (not fabricated)
    expect(html).toContain('来自');
    expect(html).toContain('ablation-sweep › dispatch'); // real provenance
    expect(html).toContain('线程已暂停等待');
    expect(html).toContain('批准');
    expect(html).toContain('拒绝并反馈');
    expect(html).toContain('12 分钟'); // real relative queued time
  });

  it('shows a real command mono block when present (no fabricated $ estimate)', () => {
    const html = render([apr({ reason: null, command: 'cortex dispatch --gpus 8' })]);
    expect(html).toContain('cortex dispatch --gpus 8');
  });

  it('omits the 来自 provenance segment when provenance is null (honest, never fabricated)', () => {
    const html = render([apr({ provenance: null })]);
    expect(html).toContain('线程已暂停等待');
    expect(html).not.toContain('来自');
  });

  it('collapses the non-expanded cards: tier + title + the diff sub-line with real id and provenance', () => {
    const html = render(
      [
        apr({ id: 'a', title: 'first' }),
        apr({ id: 'b', title: '给 gpu-preflight 增加 VRAM 校验', operation: '行为性修改', provenance: 'ablation-sweep › review' }),
      ],
      'a',
    );
    expect(html).toContain('给 gpu-preflight 增加 VRAM 校验');
    expect(html).toContain('审批 · 行为性修改');
    expect(html).toContain('b · 来自 ablation-sweep › review · 点开看 diff ›');
  });

  it('swaps the expanded card when a different id is expanded', () => {
    const first = render([apr({ id: 'a', title: 'alpha' }), apr({ id: 'b', title: 'beta' })], 'a');
    const second = render([apr({ id: 'a', title: 'alpha' }), apr({ id: 'b', title: 'beta' })], 'b');
    // when 'b' is expanded its approve/reject buttons appear; 'a' becomes the collapsed diff row
    expect(second).toContain('a · 来自');
    expect(second).toContain('点开看 diff ›');
    expect(first).toContain('b · 来自');
  });

  it('renders the empty state when nothing is pending', () => {
    const html = render([]);
    expect(html).toContain('没有待处理的审批');
    expect(html).not.toContain('$');
  });
});
