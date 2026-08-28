// input:  mounted task detail, query doubles, and shared bare Modal shell
// output: Full-bleed chrome, independent body scroll, layered backgrounds, and dismissal regressions
// pos:    Desktop TaskModal shell characterization
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';

const harness = vi.hoisted(() => ({ modalProps: null as any }));

vi.mock('@/design/Modal', () => ({
  Modal: (props: any) => {
    harness.modalProps = props;
    return <div data-shared-modal>{props.children}</div>;
  },
}));

vi.mock('@/i18n', () => ({
  useVocab: () => new Proxy({}, { get: (_target, key) => String(key) }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    tasks: { verification: { queryOptions: (input: unknown) => ({ input }) } },
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

import { TaskModal } from './TaskModal';

function task(): TaskInfo {
  return {
    id: 'T-9', text: 'Preserve the detail shell', project: 'atlas', status: 'open',
    priority: 'medium', actionable: true, claimedBy: null, claimThreadId: null,
    blockedBy: null, dependsOn: [], plan: null, template: 'manager', why: 'Keep context',
    doneWhen: 'The shell is unchanged',
  };
}

beforeEach(() => { harness.modalProps = null; });

describe('TaskModal shell characterization', () => {
  it('locks full-bleed content, independent scrolling, and split shell backgrounds', () => {
    const onClose = vi.fn();
    const tree = create(<TaskModal task={task()} allTasks={[]} pending={false}
      onClose={onClose} onComplete={vi.fn()} onUnblock={vi.fn()} />);

    expect(harness.modalProps).toMatchObject({
      chrome: 'bare', size: 'custom', open: true, showClose: false,
      contentStyle: {
        width: 760, maxHeight: '84vh', background: 'var(--proto-alt)',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      },
      bodyStyle: { display: 'contents' },
      contentDataAttributes: { 'data-task-modal-id': 'T-9' },
    });
    expect(harness.modalProps.contentStyle.padding).toBeUndefined();

    const scrollingBody = tree.root.findAllByType('div').find((node) =>
      node.props.style?.overflow === 'auto' && node.props.style?.gridTemplateColumns === '1.5fr 1fr');
    const header = tree.root.findAllByType('div').find((node) =>
      node.props.style?.background === 'var(--proto-card)' && node.props.style?.flex === 'none');
    expect(scrollingBody?.props.style).toMatchObject({ flex: 1, minHeight: 0 });
    expect(header).toBeTruthy();

    act(() => harness.modalProps.onOpenChange(false));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
