import { describe, it, expect } from 'vitest';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { defaultSelectedId, pendingLabel, statusPill } from './approval-center-vm';

function mk(over: Partial<ApprovalInfo> = {}): ApprovalInfo {
  return {
    id: 'a1',
    title: 'Some approval',
    projectId: null,
    operation: 'do the thing',
    reason: 'because',
    impact: 'small',
    command: 'bash scripts/dispatch.sh',
    status: 'pending',
    queuedAt: '2026-07-05',
    decidedAt: null,
    feedback: null,
    provenance: null,
    taskRef: null,
    ...over,
  };
}

describe('defaultSelectedId', () => {
  const list = [mk({ id: 'a' }), mk({ id: 'b' })];
  it('keeps the current id when still present', () => {
    expect(defaultSelectedId(list, 'b')).toBe('b');
  });
  it('falls back to the first entry when current is gone or null', () => {
    expect(defaultSelectedId(list, 'zzz')).toBe('a');
    expect(defaultSelectedId(list, null)).toBe('a');
  });
  it('returns null for an empty list', () => {
    expect(defaultSelectedId([], 'a')).toBeNull();
  });
});

describe('approval copy language', () => {
  it('renders pills and the pending count in the UI language', () => {
    expect(statusPill('approved', 'en').text).toBe('✓ approved');
    expect(statusPill('approved', 'zh').text).toBe('✓ 已批准');
    expect(pendingLabel(2, 'en')).toBe('2 approvals pending');
    expect(pendingLabel(2, 'zh')).toBe('2 条待审批');
  });
});
