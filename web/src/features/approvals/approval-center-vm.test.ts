import { describe, it, expect } from 'vitest';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import {
  statusPill,
  pendingLabel,
  toListCard,
  toDetail,
  defaultSelectedId,
  DASH,
} from './approval-center-vm';

function mk(over: Partial<ApprovalInfo> = {}): ApprovalInfo {
  return {
    id: 'a1',
    title: 'Some approval',
    operation: 'do the thing',
    reason: 'because',
    impact: 'small',
    command: 'cortex-run --dispatch',
    status: 'pending',
    queuedAt: '2026-07-05',
    decidedAt: null,
    feedback: null,
    provenance: null,
    taskRef: null,
    ...over,
  };
}

describe('statusPill', () => {
  it.each([
    ['pending', '● pending'],
    ['approved', '✓ approved'],
    ['rejected', '✕ rejected'],
    ['failed', 'failed'],
  ] as const)('maps %s to its semantic label', (status, label) => {
    expect(statusPill(status).text).toBe(label);
  });
});

describe('pendingLabel', () => {
  it('is singular for 1', () => {
    expect(pendingLabel(1)).toBe('1 approval pending');
  });
  it('is plural for 0 and >1', () => {
    expect(pendingLabel(0)).toBe('0 approvals pending');
    expect(pendingLabel(3)).toBe('3 approvals pending');
  });
});

describe('toListCard', () => {
  it('carries id/title and queuedAt as age', () => {
    expect(toListCard(mk({ id: 'x', title: 'T', queuedAt: '2026-07-05' }))).toEqual({
      id: 'x',
      title: 'T',
      age: '2026-07-05',
      origin: null,
    });
  });
  it('leaves age null when queuedAt is null (no fabrication)', () => {
    expect(toListCard(mk({ queuedAt: null })).age).toBeNull();
  });
  it('carries the provenance origin when present, null when absent (§12 C item 13)', () => {
    expect(toListCard(mk({ provenance: 'thread thr_1 (task 89dd)' })).origin).toBe(
      'thread thr_1 (task 89dd)',
    );
    expect(toListCard(mk({ provenance: null })).origin).toBeNull();
  });
});

describe('toDetail', () => {
  it('maps real operation/reason/impact through', () => {
    const d = toDetail(mk({ operation: 'op', reason: 'rs', impact: 'im' }));
    expect(d.operation).toBe('op');
    expect(d.reason).toBe('rs');
    expect(d.impact).toBe('im');
  });
  it('renders — placeholders for missing fields (no fabrication)', () => {
    const d = toDetail(mk({ operation: null, reason: null, impact: null }));
    expect(d.operation).toBe(DASH);
    expect(d.reason).toBe(DASH);
    expect(d.impact).toBe(DASH);
  });
  it('exposes command + hasCommand when present', () => {
    const d = toDetail(mk({ command: 'cortex-run x' }));
    expect(d.command).toBe('cortex-run x');
    expect(d.hasCommand).toBe(true);
  });
  it('omits the command block when command is null or blank', () => {
    expect(toDetail(mk({ command: null })).hasCommand).toBe(false);
    expect(toDetail(mk({ command: '   ' })).hasCommand).toBe(false);
  });
  it('prefixes queued with the date, null when absent', () => {
    expect(toDetail(mk({ queuedAt: '2026-07-05' })).queued).toBe('queued 2026-07-05');
    expect(toDetail(mk({ queuedAt: null })).queued).toBeNull();
  });
  it('carries reject feedback through', () => {
    expect(toDetail(mk({ status: 'rejected', feedback: 'nope' })).feedback).toBe('nope');
  });
  it('maps the provenance origin + parsed task ref, null when absent (§12 C item 13)', () => {
    const d = toDetail(mk({ provenance: 'manager c2a3 raised this', taskRef: 'c2a3' }));
    expect(d.origin).toBe('manager c2a3 raised this');
    expect(d.task).toBe('c2a3');
    const bare = toDetail(mk({ provenance: null, taskRef: null }));
    expect(bare.origin).toBeNull();
    expect(bare.task).toBeNull();
  });
});

describe('defaultSelectedId', () => {
  const list = [mk({ id: 'a' }), mk({ id: 'b' })];
  it('keeps the current id when still present', () => {
    expect(defaultSelectedId(list, 'b')).toBe('b');
  });
  it('falls back to the first entry when current is gone', () => {
    expect(defaultSelectedId(list, 'zzz')).toBe('a');
  });
  it('returns null for an empty list', () => {
    expect(defaultSelectedId([], 'a')).toBeNull();
  });
});
