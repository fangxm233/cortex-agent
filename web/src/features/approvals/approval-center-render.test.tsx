import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { LangProvider } from '@/i18n';
// Components consume useVocab() → wrap every render in LangProvider (defaults to en vocab).
function renderToStaticMarkup(el: ReactElement): string {
  return renderRaw(createElement(LangProvider, null, el));
}
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { ApprovalCenterView } from './ApprovalCenterModal';

// react-dom/server render checks for the pure overlay chrome (browser click-through E2E is proven in
// the live harness; these lock the 1:1 structure vs prototype.dc.html L1317-1405 + proto-shot 03/20).

function entry(over: Partial<ApprovalInfo> = {}): ApprovalInfo {
  return {
    id: 'ap1',
    title: 'Over-budget dispatch — 8×A100 ablation sweep',
    operation: 'Dispatch the 8×A100 ablation sweep on gpu-01',
    reason: 'The 8-seed DR ablation needs 8×A100 in one window.',
    impact: 'Budget only — no repo or data writes.',
    command: 'cortex-run --dispatch T-045 --gpus 8 --max-hours 6',
    status: 'pending',
    queuedAt: '2026-07-05',
    decidedAt: null,
    feedback: null,
    provenance: null,
    taskRef: null,
    ...over,
  };
}

function view(over: Partial<Parameters<typeof ApprovalCenterView>[0]> = {}) {
  return renderToStaticMarkup(
    <ApprovalCenterView
      entries={[entry()]}
      selectedId="ap1"
      armed={false}
      feedback=""
      pending={false}
      onSelect={() => {}}
      onClose={() => {}}
      onArm={() => {}}
      onCancel={() => {}}
      onApprove={() => {}}
      onReject={() => {}}
      onFeedback={() => {}}
      {...over}
    />,
  );
}

describe('ApprovalCenterView', () => {
  it('renders the header title, pending badge and the PENDING_APPROVALS.md path', () => {
    const html = view();
    expect(html).toContain('Approvals');
    expect(html).toContain('1 approval pending');
    expect(html).toContain('~/.cortex/context/PENDING_APPROVALS.md');
    expect(html).toContain('esc');
  });

  it('renders PENDING · N + the entry title + status pill', () => {
    const html = view();
    expect(html).toContain('PENDING · 1');
    expect(html).toContain('Over-budget dispatch — 8×A100 ablation sweep');
    expect(html).toContain('● pending');
  });

  it('renders the OPERATION / REASON / IMPACT grid with real values', () => {
    const html = view();
    expect(html).toContain('OPERATION');
    expect(html).toContain('REASON');
    expect(html).toContain('IMPACT');
    expect(html).toContain('Dispatch the 8×A100 ablation sweep on gpu-01');
    expect(html).toContain('Budget only — no repo or data writes.');
  });

  it('renders the real COMMAND mono block (no fabricated ESTIMATE table)', () => {
    const html = view();
    expect(html).toContain('COMMAND');
    expect(html).toContain('cortex-run --dispatch T-045 --gpus 8 --max-hours 6');
    expect(html).not.toContain('ESTIMATE');
    expect(html).not.toContain('estimated cost');
  });

  it('renders — placeholders for missing operation/reason/impact', () => {
    const html = view({ entries: [entry({ operation: null, reason: null, impact: null })] });
    expect(html).toContain('—');
  });

  it('renders the real origin/from + parsed task ref when provenance is present (§12 C item 13)', () => {
    const html = view({
      entries: [entry({ provenance: 'coder thread thr_ab12 (task 7c9d)', taskRef: '7c9d' })],
    });
    expect(html).toContain('coder thread thr_ab12 (task 7c9d)'); // left-card origin + detail `from`
    expect(html).toContain('task ');
    expect(html).toContain('7c9d');
  });

  it('omits origin/from/task when provenance is absent (honest, no fabrication)', () => {
    const html = view({ entries: [entry({ provenance: null, taskRef: null })] });
    expect(html).not.toContain('from <');
    expect(html).not.toContain('task <');
  });

  it('omits the COMMAND block when command is absent', () => {
    const html = view({ entries: [entry({ command: null })] });
    expect(html).not.toContain('COMMAND');
  });

  it('renders the unarmed footer (Reject — feedback / Approve)', () => {
    const html = view();
    expect(html).toContain('Reject — feedback');
    expect(html).toContain('Approve');
    expect(html).toContain('On decision → PENDING_APPROVALS.md flips');
    expect(html).not.toContain('Confirm reject');
  });

  it('renders the armed footer (feedback input + Cancel + Confirm reject)', () => {
    const html = view({ armed: true, feedback: 'too costly' });
    expect(html).toContain('Reason — sent back to the agent…');
    expect(html).toContain('Cancel');
    expect(html).toContain('Confirm reject');
    expect(html).not.toContain('Reject — feedback');
  });

  it('renders the ✓ All-clear empty state when there are no entries', () => {
    const html = view({ entries: [], selectedId: null });
    expect(html).toContain('All clear');
    expect(html).toContain('New approvals appear here and as cards in chat');
    expect(html).not.toContain('PENDING ·');
  });
});
