// input:  React renderer, mobile kit and presentation views
// output: Mobile readability and surface regression tests
// pos:    Guard mobile materials, typography and clearance
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { MC, MCard, MGroupLabel, MPill, MScreen, MScrollBody, MTabHeader } from '../ui/kit';
import { MTasksView, type MTasksCopy } from './MTasksView';
import type { MSessionRow } from './m-session-list-vm';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';

const noop = () => {};
const taskCopy = { title: 'Tasks', done: 'Done' } as MTasksCopy;
const sessionCopy: MSessionListCopy = { title: 'Sessions', empty: 'Empty' };
const sessionRow = (id: string, title: string): MSessionRow => ({
  id, title, time: '3h', running: false, numTurns: null, unread: false, status: { kind: 'idle', text: '' },
});

describe('mobile presentation', () => {
  it('keeps useful labels readable and cards unblurred', () => {
    const tree = create(<><MGroupLabel>History</MGroupLabel><MPill tone="done">Done</MPill><MCard>Card</MCard></>);
    const label = tree.root.findByType(MGroupLabel).findByType('div');
    expect(label.props.style).toMatchObject({ fontSize: 11, color: MC.muted });
    expect(tree.root.findByType(MPill).findByType('span').props.style.fontSize).toBe(11);
    expect(tree.root.findByType(MCard).findByType('div').props.style).toMatchObject({
      background: 'var(--m-float-bg)', boxShadow: 'var(--m-float-ring), var(--m-float-shadow)',
    });
    expect(tree.root.findByType(MCard).findByType('div').props.style.backdropFilter).toBeUndefined();
    expect(MC.card).toBe('var(--m-card)');
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

  it('keeps only the title header and scheduled entry above sessions', () => {
    const tree = create(<MSessionListView rows={[]} copy={sessionCopy} presence="connected"
      newLabel="New" scheduled={{ unread: 2, onOpen: noop }} onOpen={noop} onNew={noop} />);
    expect(tree.root.findByType(MScreen).props.header.type).toBe(MTabHeader);
    expect(tree.root.findByProps({ 'aria-label': 'Scheduled' }).props.onClick).toBe(noop);
    expect(tree.root.findByProps({ 'aria-label': '2 unread scheduled' })).toBeTruthy();
    tree.unmount();
  });

  it('renders each session as an unblurred tile under a floating glass header', () => {
    const tree = create(<MSessionListView rows={[sessionRow('a', 'First'), sessionRow('b', 'Second')]}
      copy={sessionCopy} presence="connected" newLabel="New" onOpen={noop} onNew={noop} />);
    const body = tree.root.findByType(MScrollBody);
    const bodyJson = JSON.stringify(body.findAllByType('div').map((node) => node.props.style));
    expect(bodyJson).not.toContain('backdropFilter');
    const tiles = body.findAll((node) => node.type === 'div' && node.props.style?.background === 'var(--m-float-bg)');
    expect(tiles).toHaveLength(2);
    expect(bodyJson).toContain('var(--m-header-clearance, 0px)');
    expect(bodyJson).toContain('var(--m-tabbar-clearance, 0px)');
    const header = tree.root.findByProps({ 'data-floating-header': 'true' });
    expect(header.findByProps({ 'data-tab-header': 'true' }).props.style.backdropFilter).toBe('var(--glass-filter)');
    tree.unmount();
  });
});
