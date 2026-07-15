import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { en } from '@/i18n';
import { MobileApprovalsView } from './MobileApprovalsScreen';
import { buildMobileApprovalsVm } from './mobile-approvals-vm';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';

function mk(p: Partial<ApprovalInfo> & { id: string }): ApprovalInfo {
  return {
    id: p.id,
    title: p.title ?? 'Untitled',
    operation: p.operation ?? null,
    reason: p.reason ?? null,
    impact: p.impact ?? null,
    command: p.command ?? null,
    status: p.status ?? 'pending',
    queuedAt: p.queuedAt ?? null,
    decidedAt: p.decidedAt ?? null,
    feedback: p.feedback ?? null,
    provenance: p.provenance ?? null,
    taskRef: p.taskRef ?? null,
  };
}

const NOW = new Date('2026-07-09T12:00:00Z');

function view(entries: ApprovalInfo[], over: Partial<Parameters<typeof MobileApprovalsView>[0]> = {}) {
  const vm = buildMobileApprovalsVm(entries, NOW);
  return renderToStaticMarkup(
    <MobileApprovalsView
      vm={vm}
      vocab={en}
      armed={false}
      feedback=""
      busy={false}
      onBack={() => {}}
      onApprove={() => {}}
      onArm={() => {}}
      onCancel={() => {}}
      onReject={() => {}}
      onFeedback={() => {}}
      {...over}
    />,
  );
}

const seed: ApprovalInfo[] = [
  mk({ id: 'a', title: 'Add a VRAM check step to gpu-preflight', operation: 'Skill · behavior change', reason: 'Two CUDA OOMs — add a preflight guard', impact: 'affects every future GPU dispatch', queuedAt: '2026-07-09' }),
  mk({ id: 'b', title: 'Over-budget dispatch — 8×A100 ablation', operation: 'Over-budget', queuedAt: '2026-07-09' }),
  mk({ id: 'c', title: 'Delete 12 stale experiment files', operation: 'Delete data', queuedAt: '2026-07-09' }),
  mk({ id: 'r1', title: 'Edited CORTEX.md', status: 'approved', decidedAt: '2026-07-08' }),
  mk({ id: 'r2', title: 'Killed daemon mid-run', status: 'rejected', decidedAt: '2026-07-05' }),
];

describe('MobileApprovalsView (10e)', () => {
  it('renders the screen marker + status-bar gutter + header (back / title / badge / md path)', () => {
    const html = view(seed);
    expect(html).toContain('data-screen-label="10e"');
    expect(html).toContain('padding-top:env(safe-area-inset-top)');
    expect(html).toContain('‹');
    expect(html).toContain(en.approvals); // vocab.approvals title
  });

  it('renders the pending badge count with the vocab suffix', () => {
    const html = view(seed);
    expect(html).toContain('3');
    expect(html).toContain(en.toProcess);
    expect(html).toContain('PENDING_APPROVALS.md');
  });

  it('first card shows real tier / title / reason / judgement + two ≥44px decision buttons', () => {
    const html = view(seed);
    expect(html).toContain('Skill · behavior change');
    expect(html).toContain('Add a VRAM check step to gpu-preflight');
    expect(html).toContain('Two CUDA OOMs — add a preflight guard');
    expect(html).toContain('affects every future GPU dispatch');
    expect(html).toContain(en.approve); // Approve
    expect(html).toContain(en.rejectFeedback); // Reject — feedback / 拒绝并反馈
    expect(html).toContain('height:44px');
  });

  it('renders the remaining pending entries as collapsed queue rows', () => {
    const html = view(seed);
    expect(html).toContain('Over-budget dispatch — 8×A100 ablation');
    expect(html).toContain('Delete 12 stale experiment files');
  });

  it('renders the 本周已处理 divider + ✓/✕ processed rows within the week', () => {
    const html = view(seed);
    expect(html).toContain(en.weekProcessed);
    expect(html).toContain('✓');
    expect(html).toContain('Edited CORTEX.md');
    expect(html).toContain('✕');
    expect(html).toContain('Killed daemon mid-run');
  });

  it('renders the Slack sync footer', () => {
    const html = view(seed);
    expect(html).toContain(en.slackSynced);
    expect(html).toContain('/approval');
    expect(html).toContain('approve 1');
  });

  it('shows the armed feedback input + confirm/cancel when armed', () => {
    const html = view(seed, { armed: true });
    expect(html).toContain(en.denyConfirm); // Confirm reject
    expect(html).toContain(en.cancel);
    expect(html).toContain('<input');
  });

  it('shows an all-clear card when there are no pending entries', () => {
    const html = view([mk({ id: 'r', title: 'Done thing', status: 'approved', decidedAt: '2026-07-08' })]);
    expect(html).toContain(en.aprEmptyTitle);
    expect(html).toContain('0');
  });
});
