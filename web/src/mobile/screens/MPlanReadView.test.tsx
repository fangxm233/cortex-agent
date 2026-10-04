import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { PlanCardModel } from '@/features/session/interaction/interaction-vm';
import { en } from '@/i18n';
import { MPlanReadView } from './MPlanReadView';

vi.mock('@/design/ChatMarkdown', () => ({ ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div> }));

const plan: PlanCardModel = {
  requestId: 'plan-1', status: 'pending', title: 'Storage plan', filePath: '/plan.md',
  lineCount: 2, planContent: '# Storage\nUse SQLite', feedback: null, ts: null, timeLabel: null,
};


describe('MPlanReadView', () => {
  it('keeps the reading progress bar and pending approve/reject actions', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const renderer = create(
      <MPlanReadView model={plan} onBack={vi.fn()} onApprove={onApprove} onReject={onReject} />,
    );

    const progressBars = renderer.root.findAll((node) => node.type === 'div' && node.props.style?.height === 3);
    expect(progressBars).toHaveLength(1);
    expect(progressBars[0].findAllByType('div').find((node) => node.props.style?.width !== undefined)?.props.style.width).toBe('0%');

    const buttons = renderer.root.findAllByType('button');
    expect(buttons).toHaveLength(3);
    act(() => buttons[1].props.onClick());
    act(() => buttons[2].props.onClick());
    expect(onReject).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer.toJSON())).toContain(en.ixApproveRun);
  });

  it('keeps terminal status visible and removes pending controls', () => {
    const renderer = create(
      <MPlanReadView model={{ ...plan, status: 'approved' }}
        onBack={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} />,
    );

    expect(renderer.root.findAll((node) => node.type === 'div' && node.props.style?.height === 3)).toHaveLength(0);
    expect(renderer.root.findAllByType('button')).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain(en.ixPlanApprovedPill);
  });
});
