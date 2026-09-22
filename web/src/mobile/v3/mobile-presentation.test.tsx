// input:  React renderer, mobile kit and presentation views
// output: Mobile readability and surface regression tests
// pos:    Guard mobile typography, status cards and clearance
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { MC, MCard, MGroupLabel, MPill, MScrollBody } from '../ui/kit';
import { MTasksView, type MTasksCopy } from './MTasksView';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';

const noop = () => {};
const taskCopy = { title: 'Tasks', done: 'Done' } as MTasksCopy;
const sessionCopy: MSessionListCopy = {
  title: 'Sessions', today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier',
  empty: 'Empty', sessionCount: '{n} sessions', approvalsPending: '{n} approvals',
};

describe('mobile presentation', () => {
  it('keeps useful labels readable and cards unblurred', () => {
    const tree = create(<><MGroupLabel>History</MGroupLabel><MPill tone="done">Done</MPill><MCard>Card</MCard></>);
    const label = tree.root.findByType(MGroupLabel).findByType('div');
    expect(label.props.style).toMatchObject({ fontSize: 11, color: MC.muted });
    expect(tree.root.findByType(MPill).findByType('span').props.style.fontSize).toBe(11);
    expect(tree.root.findByType(MCard).findByType('div').props.style.backdropFilter).toBeUndefined();
    tree.unmount();
  });

  it('does not fade completed task cards or remove their content', () => {
    const task = { id: 'task-1', text: 'Completed task with a long path', status: 'done' } as TaskInfo;
    const tree = create(<MTasksView groups={[{ kind: 'done', tasks: [task] }]} copy={taskCopy}
      expandedIds={new Set()} onToggleExpand={noop} onOpenTask={noop} onOpenThread={noop} onOpenApprovals={noop} />);
    const card = tree.root.findByType(MCard).findByType('div');
    expect(card.props.style.opacity).toBeUndefined();
    expect(JSON.stringify(tree.toJSON())).toContain(task.text);
    tree.unmount();
  });

  it('preserves date buckets and floating-tab clearance', () => {
    const tree = create(<MSessionListView groups={[{ key: 'TODAY', rows: [] }, { key: 'YESTERDAY', rows: [] }]}
      copy={sessionCopy} presence="connected" newLabel="New" onOpen={noop} onNew={noop} />);
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('Today');
    expect(json).toContain('Yesterday');
    expect(json).not.toContain('backdropFilter');
    const body = tree.root.findByType(MScrollBody);
    expect(JSON.stringify(body.findAllByType('div').map((node) => node.props.style)))
      .toContain('var(--m-tabbar-clearance, 0px)');
    tree.unmount();
  });
});
