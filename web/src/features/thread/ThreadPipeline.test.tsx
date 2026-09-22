// input:  ThreadPipeline, renderer, synthetic view model
// output: Card material, metadata and keyboard regressions
// pos:    Thread pipeline presentation tests
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { ThreadPipeline } from './ThreadPipeline';
import type { DetailStep, ThreadDetailVm } from './thread-detail-vm';

vi.mock('./ThreadStepChat', () => ({ ThreadStepChat: () => null }));

function step(kind: DetailStep['kind'], stepIndex: number): DetailStep {
  return { kind, stepIndex, title: kind, note: 'Stage note', meta: 'Stage metadata',
    hasConnector: false, subs: [], subCount: 0, sessionId: null, sessionName: null, profile: null };
}

const vm: ThreadDetailVm = {
  name: 'Example', tid: 'example', pill: { text: 'Running', bg: '', fg: '' },
  template: '', started: '', elapsed: '', cost: '', task: '', depthDots: [], depthText: '', live: true,
  steps: [step('pending', 0), step('running', 1)],
  artifact: { path: null, live: false, updated: '', taskId: null, taskProject: null,
    workspacePath: null, writtenBy: [], content: null },
};

describe('ThreadPipeline presentation', () => {
  it('uses readable metadata and expands pending steps with the keyboard', () => {
    const renderer = create(<LangProvider><ThreadPipeline vm={vm} onOpenSub={() => {}} /></LangProvider>);
    const pending = renderer.root.findByProps({ 'data-step-kind': 'pending' });
    expect(pending.props.tabIndex).toBe(0);
    expect(pending.props.style.background).toBe('var(--material-card-bg)');
    expect(pending.props.style.backdropFilter).toBeUndefined();
    const label = pending.findAllByType('span').find(node => node.children.includes('Stage metadata'))!;
    expect(label.props.style.color).toBe('var(--proto-muted)');
    expect(label.props.style.font).toContain('11px');
    const preventDefault = vi.fn();
    act(() => pending.props.onKeyDown({ key: 'Enter', preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ 'data-expanded-step': 'true' }).props.style.background).toBe('var(--material-card-bg)');
    act(() => renderer.unmount());
  });
});
