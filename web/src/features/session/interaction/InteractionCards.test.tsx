// input:  Interaction cards, plan overlay, React renderer
// output: Interaction presentation and action regression tests
// pos:    Question and plan card accessibility coverage
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D_INT_COPY, DeskAskCard, DeskPlanCard } from './InteractionCards';
import { PlanReadOverlay } from './PlanReadOverlay';
import { emptyDeskAsk, type AskCardModel, type PlanCardModel } from './interaction-vm';

vi.mock('./useInteractionTtl', () => ({ useTtlSeconds: () => 60 }));
vi.mock('@/design/ChatMarkdown', () => ({ ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div> }));

const copy = D_INT_COPY.en;
const ask: AskCardModel = {
  requestId: 'ask-1', shortId: 'ask-1', status: 'pending', level: null, ts: null, timeLabel: null,
  questions: [{ question: 'Choose storage', multiSelect: false, answer: null,
    options: [{ label: 'SQLite', description: 'Local database' }] }],
};
const plan: PlanCardModel = {
  requestId: 'plan-1', status: 'pending', title: 'Storage plan', filePath: '/plan.md',
  lineCount: 2, planContent: '# Storage\nUse SQLite', feedback: null, ts: null, timeLabel: null,
};
const trees: ReactTestRenderer[] = [];
function mount(node: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(node); });
  trees.push(tree);
  return tree;
}
afterEach(() => {
  act(() => trees.splice(0).forEach((tree) => tree.unmount()));
  vi.unstubAllGlobals();
});

describe('interaction presentation', () => {
  it('uses native pressed choices and a disabled unanswered submit', () => {
    const onState = vi.fn();
    const tree = mount(<DeskAskCard model={ask} state={emptyDeskAsk} copy={copy}
      onState={onState} onSubmit={vi.fn()} busy={false} />);
    const [option, , submit] = tree.root.findAllByType('button');
    expect(option.props.style.background).toBe('var(--material-control-bg)');
    expect(option.props.style.backdropFilter).toBeUndefined();
    expect(option.props['aria-pressed']).toBe(false);
    expect(option.props.className).toContain('focus-visible:outline');
    expect(submit.props.disabled).toBe(true);
    act(() => option.props.onClick());
    expect(onState.mock.calls[0][0].picks).toEqual({ 0: ['SQLite'] });
  });

  it('keeps resolved questions readable without fading the card', () => {
    const tree = mount(<DeskAskCard model={{ ...ask, status: 'answered' }} state={emptyDeskAsk}
      copy={copy} onState={vi.fn()} onSubmit={vi.fn()} busy={false} />);
    const card = tree.root.findAllByType('div')[0];
    expect(card.props.style.background).toBe('var(--material-card-bg)');
    expect(card.props.style.boxShadow).toBe('var(--material-card-shadow)');
    expect(card.props.style.backdropFilter).toBeUndefined();
    expect(card.props.style.opacity).toBeUndefined();
    expect(tree.root.findAllByType('button')).toHaveLength(0);
  });

  it('keeps feedback input stable and requires text before returning a plan', () => {
    const onReject = vi.fn();
    const tree = mount(<DeskPlanCard model={plan} copy={copy} feedbackOpen
      onFeedbackOpen={vi.fn()} onApprove={vi.fn()} onReject={onReject} onOpenRead={vi.fn()} busy={false} />);
    const input = tree.root.findByType('textarea');
    expect(input.props.style.background).toBe('var(--material-inset-bg)');
    const confirm = tree.root.findAllByType('button').at(-1)!;
    expect(confirm.props.disabled).toBe(true);
    act(() => input.props.onChange({ target: { value: ' Keep the logs ' } }));
    act(() => confirm.props.onClick());
    expect(onReject).toHaveBeenCalledWith('Keep the logs');
  });

  it('keeps reading available but disables a busy plan approval', () => {
    const onOpenRead = vi.fn();
    const tree = mount(<DeskPlanCard model={plan} copy={copy} feedbackOpen={false}
      onFeedbackOpen={vi.fn()} onApprove={vi.fn()} onReject={vi.fn()} onOpenRead={onOpenRead} busy />);
    const [read, , approve] = tree.root.findAllByType('button');
    act(() => read.props.onClick());
    expect(onOpenRead).toHaveBeenCalledOnce();
    expect(approve.props.disabled).toBe(true);
  });

  it('retains custom plan overlay Escape and callback behavior', () => {
    const addEventListener = vi.fn();
    vi.stubGlobal('window', { addEventListener, removeEventListener: vi.fn() });
    const onClose = vi.fn();
    const onApprove = vi.fn();
    const tree = mount(<PlanReadOverlay model={plan} copy={copy} onClose={onClose}
      onApprove={onApprove} onRequestChanges={vi.fn()} />);
    expect(tree.root.findByProps({ role: 'dialog' }).props.style.backdropFilter).toBe('var(--glass-filter)');
    act(() => addEventListener.mock.calls[0][1]({ key: 'Escape' }));
    expect(onClose).toHaveBeenCalledOnce();
    act(() => tree.root.findAllByType('button')[2].props.onClick());
    expect(onApprove).toHaveBeenCalledOnce();
  });
});
