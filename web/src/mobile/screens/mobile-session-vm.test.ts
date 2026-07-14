import { describe, it, expect } from 'vitest';
import type { ThreadDetail, ApprovalInfo } from '@cortex-agent/ui-contract';
import {
  sessionInitials,
  headerStatus,
  zhDivider,
  buildMobileStepper,
  mobileApprovalDesc,
  toolChips,
  DASH,
} from './mobile-session-vm';

// Pure view-model for the mobile session screen 5a (scheme.dc.html L2932-3003, task c880). Real
// data is the only variable; every measurement lives in the presentational components. Neutral test
// fixtures (守则11 — no private project/exp names).

describe('sessionInitials', () => {
  it('takes the first two word initials, uppercased', () => {
    expect(sessionInitials({ label: 'nimbus orchard', name: 'x' })).toBe('NO');
  });
  it('falls back to name when label is null', () => {
    expect(sessionInitials({ label: null, name: 'atlas' })).toBe('AT');
  });
  it('single word → first two letters', () => {
    expect(sessionInitials({ label: null, name: 'atlas' })).toBe('AT');
  });
  it('empty → two dashes', () => {
    expect(sessionInitials({ label: null, name: '' })).toBe(DASH + DASH);
  });
});

describe('headerStatus', () => {
  it('running with real turns and a dash cost placeholder', () => {
    expect(headerStatus({ running: true, turns: 12 })).toEqual({
      word: 'running',
      turnsLabel: '12 turns',
      cost: DASH,
    });
  });
  it('idle when not streaming', () => {
    expect(headerStatus({ running: false, turns: 0 }).word).toBe('idle');
  });
  it('renders a dash when the agent-turn count is unknown (null)', () => {
    expect(headerStatus({ running: true, turns: null }).turnsLabel).toBe(DASH);
  });
});

describe('zhDivider', () => {
  const now = new Date(2026, 6, 9, 10, 0); // 2026-07-09 10:00 local
  it('same calendar day → 今天 HH:MM', () => {
    const ts = new Date(2026, 6, 9, 7, 42).toISOString();
    expect(zhDivider(ts, now)).toBe('今天 07:42');
  });
  it('previous day → 昨天 HH:MM', () => {
    const ts = new Date(2026, 6, 8, 23, 5).toISOString();
    expect(zhDivider(ts, now)).toBe('昨天 23:05');
  });
  it('older → M月D日 HH:MM', () => {
    const ts = new Date(2026, 6, 3, 9, 8).toISOString();
    expect(zhDivider(ts, now)).toBe('7月3日 09:08');
  });
});

function step(over: Partial<ThreadDetail['steps'][number]> = {}): ThreadDetail['steps'][number] {
  return {
    stepIndex: 0,
    agentSlotId: 'a0',
    stage: 'plan',
    status: 'completed',
    executionId: null,
    sessionId: null,
    sessionName: null,
    costUsd: null,
    numTurns: null,
    durationS: null,
    startedAt: null,
    endedAt: null,
    outputSummary: null,
    ...over,
  };
}

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    id: 'thr_abcd',
    templateName: 'experiment-pipeline',
    currentStep: { index: 2, name: 'review' },
    status: 'running',
    projectId: 'nimbus',
    createdAt: new Date(2026, 6, 9, 9, 0).toISOString(),
    updatedAt: new Date(2026, 6, 9, 9, 42).toISOString(),
    totalSteps: 4,
    artifactPath: null,
    endedAt: null,
    error: null,
    abortReason: null,
    activeAgent: 'a2',
    activeStage: 'review',
    totalCostUsd: 2.31,
    steps: [
      step({ stepIndex: 0, stage: 'plan', status: 'completed' }),
      step({ stepIndex: 1, stage: 'execute', status: 'completed' }),
      step({ stepIndex: 2, stage: 'review', status: 'running' }),
      step({ stepIndex: 3, stage: 'commit', status: 'pending' }),
    ],
    agentFlow: null,
    dispatches: [],
    children: [
      {
        id: 'thr_c1',
        templateName: 'verify-metrics',
        status: 'running',
        activeAgent: null,
        costUsd: 0,
        depth: 1,
        createdAt: new Date().toISOString(),
        taskId: null,
        children: [],
        truncated: false,
      },
      {
        id: 'thr_c2',
        templateName: 'verify-claims',
        status: 'completed',
        activeAgent: null,
        costUsd: 0,
        depth: 1,
        createdAt: new Date().toISOString(),
        taskId: null,
        children: [],
        truncated: false,
      },
    ],
    artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
    ...over,
  };
}

describe('buildMobileStepper', () => {
  it('maps each step to a node with its state and real label', () => {
    const s = buildMobileStepper(detail());
    expect(s.nodes.map((n) => n.label)).toEqual(['plan', 'execute', 'review', 'commit']);
    expect(s.nodes.map((n) => n.state)).toEqual(['done', 'done', 'running', 'pending']);
  });
  it('a line is done only when the node before it completed', () => {
    // 4 nodes → 3 connecting lines; between plan→execute (done), execute→review (done), review→commit (pending)
    const s = buildMobileStepper(detail());
    expect(s.nodes.slice(1).map((n) => n.lineDone)).toEqual([true, true, false]);
  });
  it('pill text = current step name + index/total while running', () => {
    expect(buildMobileStepper(detail()).pillText).toBe('review 3/4');
  });
  it('footer = elapsed · cost · N subthreads (real children count)', () => {
    const s = buildMobileStepper(detail());
    expect(s.footer.elapsed).toBe('42m');
    expect(s.footer.cost).toBe('$2.31');
    expect(s.footer.subCount).toBe(2);
  });
  it('empty steps → no nodes, no crash', () => {
    const s = buildMobileStepper(detail({ steps: [], currentStep: null, totalSteps: 0 }));
    expect(s.nodes).toEqual([]);
  });
});

function approval(over: Partial<ApprovalInfo> = {}): ApprovalInfo {
  return {
    id: 'ap1',
    title: 'Over-budget dispatch',
    operation: 'Dispatch the ablation sweep',
    reason: 'Needs a large GPU window.',
    impact: 'Budget only.',
    command: 'cortex-run --dispatch',
    status: 'pending',
    queuedAt: '2026-07-09',
    decidedAt: null,
    feedback: null,
    provenance: null,
    taskRef: null,
    ...over,
  };
}

describe('mobileApprovalDesc', () => {
  it('prefers the real reason', () => {
    expect(mobileApprovalDesc(approval())).toBe('Needs a large GPU window.');
  });
  it('falls back to operation when reason is null', () => {
    expect(mobileApprovalDesc(approval({ reason: null }))).toBe('Dispatch the ablation sweep');
  });
  it('dash when both absent (never fabricated)', () => {
    expect(mobileApprovalDesc(approval({ reason: null, operation: null }))).toBe(DASH);
  });
});

describe('toolChips', () => {
  it('shows the first two tool names + overflow count', () => {
    const chips = toolChips([
      { kind: 'read', input: 'a' },
      { kind: 'threads.status', input: 'b' },
      { kind: 'grep', input: 'c' },
      { kind: 'edit', input: 'd' },
    ]);
    expect(chips.names).toEqual(['read', 'threads.status']);
    expect(chips.overflow).toBe(2);
  });
  it('no overflow when ≤ 2 calls', () => {
    expect(toolChips([{ kind: 'read', input: 'a' }]).overflow).toBe(0);
  });
});
