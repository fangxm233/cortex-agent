// input:  shared approval queue facts/outcomes and mobile expansion/feedback interactions
// output: selection fallback, draft reset, and decision wiring regressions
// pos:    Mobile approval screen interaction specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MApprovalsViewProps } from './MApprovalsView';

const state = vi.hoisted(() => ({
  viewProps: null as unknown,
  approve: vi.fn<(id: string) => Promise<void>>(),
  reject: vi.fn<(id: string, feedback?: string) => Promise<void>>(),
  entries: [] as ApprovalInfo[],
}));

vi.mock('@/features/approvals/useApprovalQueue', () => ({
  useApprovalQueue: () => ({
    entries: state.entries,
    approve: state.approve,
    reject: state.reject,
    isPending: false,
  }),
}));
vi.mock('@/features/projects/CurrentProjectProvider', () => ({
  useCurrentProject: () => ({ currentProjectId: null }),
}));
vi.mock('@/i18n', () => ({ useLang: () => 'en' }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('./MApprovalsView', () => ({
  MApprovalsView: (props: unknown) => {
    state.viewProps = props;
    return null;
  },
}));

import { MApprovalsScreen } from './MApprovalsScreen';

function approval(id: string): ApprovalInfo {
  return {
    id,
    title: `Approval ${id}`,
    projectId: null,
    operation: null,
    reason: null,
    impact: null,
    command: null,
    status: 'pending',
    queuedAt: null,
    decidedAt: null,
    feedback: null,
    provenance: null,
    taskRef: null,
  };
}

beforeEach(() => {
  state.viewProps = null;
  state.entries = [approval('apr-1'), approval('apr-2')];
  state.approve.mockReset().mockResolvedValue();
  state.reject.mockReset().mockResolvedValue();
});

describe('MApprovalsScreen', () => {
  it('owns expanded selection through shared fallback and clears feedback when cards switch', () => {
    create(<MApprovalsScreen />);
    let props = state.viewProps as MApprovalsViewProps;
    expect(props.expandedId).toBe('apr-1');

    act(() => props.onFeedback('draft for first'));
    props = state.viewProps as MApprovalsViewProps;
    expect(props.feedback).toBe('draft for first');

    act(() => props.onExpand('apr-2'));
    props = state.viewProps as MApprovalsViewProps;
    expect(props.expandedId).toBe('apr-2');
    expect(props.feedback).toBe('');
  });

  it('passes feedback to the shared reject operation and clears it when the decision settles', async () => {
    let resolve: (() => void) | undefined;
    state.reject.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    create(<MApprovalsScreen />);
    let props = state.viewProps as MApprovalsViewProps;

    act(() => props.onFeedback('  reduce scope  '));
    props = state.viewProps as MApprovalsViewProps;
    act(() => props.onReject('apr-1', props.feedback));
    expect(state.reject).toHaveBeenCalledWith('apr-1', '  reduce scope  ');
    expect((state.viewProps as MApprovalsViewProps).feedback).toBe('  reduce scope  ');

    await act(async () => {
      resolve?.();
      await new Promise((done) => setTimeout(done, 0));
    });
    expect((state.viewProps as MApprovalsViewProps).feedback).toBe('');
  });
});
