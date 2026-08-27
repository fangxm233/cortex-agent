// input:  expanded mobile approval cards, optional feedback, and decision handlers
// output: feedback presentation and reject handoff regressions
// pos:    Mobile approval queue presentation specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MApprovalsView, type MApprovalsCopy } from './MApprovalsView';
import type { MApprovalsVm } from './m-approvals-vm';

const copy: MApprovalsCopy = {
  title: 'Approvals',
  toProcess: 'pending',
  tier: 'Approval',
  from: 'from',
  paused: 'thread paused, waiting',
  approve: 'Approve',
  reject: 'Reject with feedback',
  feedbackPlaceholder: 'Optional feedback',
  seeDiff: 'tap for diff ›',
  empty: 'No pending approvals',
  globalGroup: 'GLOBAL',
};

const vm: MApprovalsVm = {
  pendingCount: 1,
  groups: [{
    projectId: null,
    cards: [{
      id: 'apr-1',
      projectId: null,
      operation: 'dispatch',
      title: 'Run a scan',
      time: '',
      reason: 'Needs capacity',
      impact: null,
      command: null,
      provenance: null,
    }],
  }],
  cards: [],
};
vm.cards = vm.groups[0].cards;

describe('MApprovalsView', () => {
  it('shows optional feedback on the expanded card and hands the draft to Reject with feedback', () => {
    const onFeedback = vi.fn();
    const onReject = vi.fn();
    const renderer = create(
      <MApprovalsView
        vm={vm}
        copy={copy}
        expandedId="apr-1"
        feedback="  reduce scope  "
        busy={false}
        onBack={vi.fn()}
        onExpand={vi.fn()}
        onFeedback={onFeedback}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );

    const field = renderer.root.findByProps({ 'data-approval-feedback': true });
    expect(field.props.value).toBe('  reduce scope  ');
    expect(field.props.placeholder).toBe('Optional feedback');
    field.props.onChange({ target: { value: 'wait for quota' } });
    expect(onFeedback).toHaveBeenCalledWith('wait for quota');

    const reject = renderer.root.findAllByType('button')
      .find((button) => button.children.join('') === 'Reject with feedback');
    expect(reject).toBeDefined();
    reject?.props.onClick();
    expect(onReject).toHaveBeenCalledWith('apr-1', '  reduce scope  ');
  });
});
