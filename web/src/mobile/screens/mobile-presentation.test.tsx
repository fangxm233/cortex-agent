import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { MC, MCard, MGroup, MGroupLabel, MPill, MScreen, MScrollBody, MTabHeader } from '../ui/kit';
import { MTasksView, type MTasksCopy } from './MTasksView';
import type { MSessionRow } from './m-session-list-vm';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';

const noop = () => {};
const taskCopy = { title: 'Tasks', done: 'Done' } as MTasksCopy;
const sessionCopy: MSessionListCopy = { title: 'Sessions', empty: 'Empty' };
const sessionRow = (id: string, title: string): MSessionRow => ({
  id, title, time: '3h', unread: false, status: { kind: 'idle', text: '' },
});

describe('mobile presentation', () => {
  it('keeps useful labels readable and cards unblurred', () => {
    const tree = create(<><MGroupLabel>History</MGroupLabel><MPill tone="done">Done</MPill><MCard>Card</MCard></>);
    const label = tree.root.findByType(MGroupLabel).findByType('div');
    expect(label.props.style).toMatchObject({ fontSize: 12, color: MC.muted });
    expect(tree.root.findByType(MPill).findByType('span').props.style.fontSize).toBe(11);
    expect(tree.root.findByType(MCard).findByType('div').props.style).toMatchObject({
      background: 'var(--m-float-bg)', boxShadow: 'var(--m-float-ring), var(--m-float-shadow)',
    });
    expect(tree.root.findByType(MCard).findByType('div').props.style.backdropFilter).toBeUndefined();
    expect(MC.card).toBe('var(--m-card)');
    tree.unmount();
  });

  it('does not fade completed task rows or remove their content', () => {
    const task = { id: 'task-1', text: 'Completed task with a long path', status: 'done' } as TaskInfo;
    const tree = create(<MTasksView groups={[{ kind: 'done', tasks: [task] }]} copy={taskCopy}
      expandedIds={new Set()} onToggleExpand={noop} onOpenTask={noop} onOpenThread={noop} onOpenApprovals={noop} />);
    const row = tree.root.findByType(MGroup).find((node) => node.type === 'div' && node.props.className === 'm-press');
    expect(row.props.style.opacity).toBeUndefined();
    expect(JSON.stringify(tree.toJSON())).toContain(task.text);
    tree.unmount();
  });

  it('keeps only the title header and scheduled entry above sessions, new session in thumb reach', () => {
    const onNew = () => {};
    const tree = create(<MSessionListView rows={[]} copy={sessionCopy} presence="connected"
      newLabel="New" scheduled={{ unread: 2, onOpen: noop }} onOpen={noop} onNew={onNew} />);
    const screen = tree.root.findByType(MScreen);
    expect(screen.props.header.type).toBe(MTabHeader);
    expect(tree.root.findByProps({ 'aria-label': 'Scheduled' }).props.onClick).toBe(noop);
    expect(tree.root.findByProps({ 'aria-label': '2 unread scheduled' })).toBeTruthy();
    expect(screen.props.overlay.props).toMatchObject({ 'aria-label': 'New', onClick: onNew });
    tree.unmount();
  });

  it('lays sessions out as one divided list under a header that frosts only once scrolled', () => {
    const tree = create(<MSessionListView rows={[sessionRow('a', 'First'), sessionRow('b', 'Second')]}
      copy={sessionCopy} presence="connected" newLabel="New" onOpen={noop} onNew={noop} />);
    const body = tree.root.findByType(MScrollBody);
    const bodyJson = JSON.stringify(body.findAllByType('div').map((node) => node.props.style));
    expect(bodyJson).not.toContain('backdropFilter');
    expect(bodyJson).not.toContain('var(--m-float-bg)');
    expect(body.findAll((node) => node.type === 'div' && node.props.className === 'm-press')).toHaveLength(2);
    expect(body.findAll((node) => node.type === 'div' && node.props['aria-hidden'] === 'true')).toHaveLength(1);
    expect(bodyJson).toContain('var(--m-header-clearance, 0px)');
    expect(bodyJson).toContain('var(--m-tabbar-clearance, 0px)');
    const header = tree.root.findByProps({ 'data-floating-header': 'true' });
    expect(header.props['data-scrolled']).toBe('false');
    expect(header.props.style['--m-header-filter']).toBeUndefined();
    expect(header.findByProps({ 'data-tab-header': 'true' }).props.style.backdropFilter).toBe('var(--m-header-filter, none)');
    const scroller = tree.root.findByProps({ 'data-m-scroller': '' });
    act(() => scroller.props.onScroll({ currentTarget: { scrollTop: 40 } }));
    expect(header.props['data-scrolled']).toBe('true');
    expect(header.props.style['--m-header-filter']).toBe(MC.glassFilter);
    tree.unmount();
  });
});
