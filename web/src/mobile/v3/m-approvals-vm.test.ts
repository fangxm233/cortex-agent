import { describe, it, expect } from 'vitest';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { buildMApprovalsVm } from './m-approvals-vm';

// Neutral placeholder approvals (守则11 — no real project names / ids).
function apr(over: Partial<ApprovalInfo>): ApprovalInfo {
  return {
    id: 'apr-a',
    title: '超预算 dispatch — 8×A100 消融扫描',
    operation: '超预算',
    reason: '预估 $12.40 超过日预算 $10.00',
    impact: '将启动 8 张 A100 约 3 小时',
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

describe('buildMApprovalsVm', () => {
  const now = Date.parse('2026-07-15T12:00:00Z');

  it('keeps only pending entries, in order, and counts them', () => {
    const vm = buildMApprovalsVm(
      [
        apr({ id: 'a', status: 'pending' }),
        apr({ id: 'b', status: 'approved' }),
        apr({ id: 'c', status: 'pending' }),
        apr({ id: 'd', status: 'rejected' }),
      ],
      now,
    );
    expect(vm.pendingCount).toBe(2);
    expect(vm.cards.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('maps real DTO fields onto the card (operation/title/reason/impact/command/provenance)', () => {
    const [card] = buildMApprovalsVm([apr({ command: 'cortex dispatch --gpus 8' })], now).cards;
    expect(card).toMatchObject({
      id: 'apr-a',
      operation: '超预算',
      title: '超预算 dispatch — 8×A100 消融扫描',
      reason: '预估 $12.40 超过日预算 $10.00',
      impact: '将启动 8 张 A100 约 3 小时',
      command: 'cortex dispatch --gpus 8',
      provenance: 'ablation-sweep › dispatch',
    });
  });

  it('derives the relative queued time from queuedAt (no fabricated clock)', () => {
    const [card] = buildMApprovalsVm([apr({ queuedAt: '2026-07-15T11:48:00Z' })], now).cards;
    expect(card.time).toBe('12 分钟');
  });

  it('carries honest nulls when optional fields are absent (never fabricated)', () => {
    const [card] = buildMApprovalsVm(
      [apr({ operation: null, reason: null, impact: null, command: null, provenance: null, queuedAt: null })],
      now,
    ).cards;
    expect(card.operation).toBeNull();
    expect(card.reason).toBeNull();
    expect(card.impact).toBeNull();
    expect(card.command).toBeNull();
    expect(card.provenance).toBeNull();
    expect(card.time).toBe('');
  });

  it('empty queue → zero count, no cards', () => {
    const vm = buildMApprovalsVm([], now);
    expect(vm.pendingCount).toBe(0);
    expect(vm.cards).toEqual([]);
  });
});
