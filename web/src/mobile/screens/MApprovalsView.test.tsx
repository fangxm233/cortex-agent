import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MApprovalsView } from './MApprovalsView';
import type { MApprovalsVm } from './m-approvals-vm';

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
    plans: [],
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
        expandedId="apr-1"
        feedback="  reduce scope  "
        busy={false}
        onBack={vi.fn()}
        onExpand={vi.fn()}
        onFeedback={onFeedback}
        onApprove={vi.fn()}
        onReject={onReject}
        onOpenPlan={vi.fn()}
      />,
    );

    const field = renderer.root.findByProps({ 'data-approval-feedback': true });
    expect(field.props.value).toBe('  reduce scope  ');
    field.props.onChange({ target: { value: 'wait for quota' } });
    expect(onFeedback).toHaveBeenCalledWith('wait for quota');

    const reject = renderer.root.findAllByType('button')
      .find((button) => button.children.join('') === 'Reject with feedback');
    expect(reject).toBeDefined();
    reject?.props.onClick();
    expect(onReject).toHaveBeenCalledWith('apr-1', '  reduce scope  ');
  });

  it('lists pending plan approvals in the count and opens the plan on tap', () => {
    const plan = { sessionId: 's-1', requestId: 'req-1', projectId: null, title: 'Nimbus sweep plan', session: 'nimbus' };
    const onOpenPlan = vi.fn();
    const renderer = create(
      <MApprovalsView
        vm={{ pendingCount: 1, groups: [{ projectId: null, cards: [], plans: [plan] }], cards: [] }}
        expandedId={null}
        feedback=""
        busy={false}
        onBack={vi.fn()}
        onExpand={vi.fn()}
        onFeedback={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onOpenPlan={onOpenPlan}
      />,
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Nimbus sweep plan');
    expect(text).not.toContain('No pending approvals');
    renderer.root.findAll((node) => typeof node.props.onClick === 'function' && node.type !== 'button')[0]?.props.onClick();
    expect(onOpenPlan).toHaveBeenCalledWith(plan);
  });
});
