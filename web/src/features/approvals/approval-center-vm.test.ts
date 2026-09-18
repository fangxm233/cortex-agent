import { describe, it, expect } from 'vitest';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { defaultSelectedId } from './approval-center-vm';

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
  it('falls back to the first entry when current is gone', () => {
    expect(defaultSelectedId(list, 'zzz')).toBe('a');
  });
  it('returns null for an empty list', () => {
    expect(defaultSelectedId([], 'a')).toBeNull();
  });
});
