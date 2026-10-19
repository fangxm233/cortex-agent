import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MC, MCard, MGroupLabel, MPill, MScreen, MScrollBody, MTabHeader } from '../ui/kit';
import { en } from '@/i18n';
import type { NoteRowVm } from '@/features/notes/notes-vm';
import type { MSessionRow } from './m-session-list-vm';
import type { MNotesVm } from './m-notes-vm';
import { MNotesView } from './MNotesView';
import { MSessionListView } from './MSessionListView';

const noop = () => {};
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

  it('keeps only the title header and scheduled entry above sessions, new session in thumb reach', () => {
    const onNew = () => {};
    const tree = create(<MSessionListView rows={[]} presence="connected"
      newLabel="New" scheduled={{ unread: 2, onOpen: noop }} onOpen={noop} onNew={onNew} />);
    const screen = tree.root.findByType(MScreen);
    expect(screen.findByType(MTabHeader).props.title).toBe('Sessions');
    expect(tree.root.findByProps({ 'aria-label': 'Scheduled' }).props.onClick).toBe(noop);
    expect(tree.root.findByProps({ 'aria-label': '2 unread scheduled' })).toBeTruthy();
    expect(screen.props.overlay.props).toMatchObject({ 'aria-label': 'New', onClick: onNew });
    // An ink pill that names itself, not an accent disc with a glow.
    expect(screen.props.overlay.props.style).toMatchObject({ background: MC.inkSolid, color: MC.inkSolidFg });
    expect(JSON.stringify(screen.props.overlay.props.style)).not.toContain('accent');
    expect(tree.root.findByProps({ 'aria-label': 'New' }).findAllByType('span').map((n) => n.children.join(''))).toEqual(['New']);
    tree.unmount();
  });

  it('opens the Projects panel from the brand mark, which carries the amber pending count', () => {
    const onProjects = vi.fn();
    const view = (needsYou: number) => create(<MSessionListView rows={[]} presence="connected"
      projects={{ needsYou, onOpen: onProjects }} newLabel="New" onOpen={noop} onNew={noop} />);
    const pending = view(3);
    const button = pending.root.findByProps({ 'data-projects-button': '' });
    expect(button.props['aria-label']).toBe('Projects, 3 need you');
    // A plain amber number beside the mark — not a filled badge.
    const count = button.findAll((node) => node.type === 'span' && node.props['data-needs-you-count'] !== undefined);
    expect(count.map((node) => node.children.join(''))).toEqual(['3']);
    expect(count[0].props.style.color).toBe('var(--proto-amber-fg)');
    expect(count[0].props.style.background).toBeUndefined();
    act(() => button.props.onClick());
    expect(onProjects).toHaveBeenCalledOnce();
    const quiet = view(0);
    const plain = quiet.root.findByProps({ 'data-projects-button': '' });
    expect(plain.props['aria-label']).toBe('Projects');
    expect(plain.findAll((node) => node.type === 'span' && node.props['data-needs-you-count'] !== undefined)).toHaveLength(0);
    pending.unmount();
    quiet.unmount();
  });

  it('lays sessions out straight on the mesh under a header that frosts only once scrolled', () => {
    const tree = create(<MSessionListView rows={[sessionRow('a', 'First'), sessionRow('b', 'Second')]}
      presence="connected" newLabel="New" onOpen={noop} onNew={noop} />);
    const body = tree.root.findByType(MScrollBody);
    const bodyJson = JSON.stringify(body.findAllByType('div').map((node) => node.props.style));
    expect(bodyJson).not.toContain('backdropFilter');
    expect(bodyJson).not.toContain('var(--m-float-bg)');
    expect(body.findAll((node) => node.type === 'div' && node.props.className === 'm-press')).toHaveLength(2);
    // Rows are set apart by spacing under their section heading, not by hairlines.
    expect(body.findAll((node) => node.type === 'div' && node.props['aria-hidden'] === 'true')).toHaveLength(0);
    expect(bodyJson).toContain('var(--m-header-clearance, 0px)');
    expect(bodyJson).toContain('calc(20px + env(safe-area-inset-bottom))');
    expect(bodyJson).not.toContain('tabbar');
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

  it('sections the rows by status — needs you, in progress, recent — keeping rail order within each', () => {
    const row = (id: string, kind: MSessionRow['status']['kind'], text = ''): MSessionRow => ({
      id, title: id, time: '1m', unread: false, status: { kind, text },
    });
    const tree = create(<MSessionListView presence="connected" newLabel="New" onOpen={noop} onNew={noop} rows={[
      row('idle-1', 'idle'), row('run', 'running', 'Running'), row('ask', 'awaiting', 'Needs your input'),
      row('wait', 'waiting-external', 'Waiting on 1 signal'), row('bg', 'background', 'Running in background'), row('idle-2', 'idle'),
    ]} />);
    const sections = tree.root.findAll((node) => node.type === 'section' && node.props['data-session-section'] !== undefined);
    expect(sections.map((node) => node.props['data-session-section'])).toEqual(['needsYou', 'active', 'recent']);
    const ids = (node: (typeof sections)[number]) => node.findAll((n) => n.props['data-session-id'] !== undefined).map((n) => n.props['data-session-id']);
    expect(sections.map(ids)).toEqual([['ask'], ['run', 'wait', 'bg'], ['idle-1', 'idle-2']]);
    expect(sections.map((node) => node.findByType(MGroupLabel).props.children)).toEqual(['Needs you', 'In progress', 'Recent']);
    // The needs-you reason reads in amber; a waiting row wears the hollow ring; idle rows carry no dot.
    const ask = tree.root.findByProps({ 'data-session-id': 'ask' });
    expect(JSON.stringify(ask.findAllByType('div').map((n) => n.props.style))).toContain('var(--proto-amber-fg)');
    expect(tree.root.findByProps({ 'data-session-id': 'wait' }).findByProps({ 'data-status-dot': 'waiting-external' }).props.style.border)
      .toContain('solid');
    expect(tree.root.findByProps({ 'data-session-id': 'idle-1' }).findAll((n) => n.props['data-status-dot'] !== undefined)).toHaveLength(0);
    tree.unmount();
  });

  it('lists notes as rows on the mesh, with the red delete key hidden until a swipe uncovers it', () => {
    const note = (id: string, completed: boolean) => ({ id, text: id, completed, timeLabel: '3d' }) as unknown as NoteRowVm;
    const vm: MNotesVm = { active: [note('open', false)], completed: [note('done', true)], previews: [], activeCount: 1, completedCount: 1 };
    const pending = () => Promise.resolve();
    const tree = create(<MNotesView vm={vm} busy={false} onBack={noop} onAdd={pending} onUpdate={pending}
      onSetCompleted={pending} onDelete={pending} onHandoff={noop} onClearCompleted={pending} />);
    const body = tree.root.findByType(MScrollBody);
    const styles = JSON.stringify(body.findAll((node) => typeof node.type === 'string').map((node) => node.props.style));
    expect(styles).not.toContain('var(--material-card-bg)');
    expect(styles).not.toContain('var(--material-card-shadow)');
    const swipe = tree.root.findByProps({ 'data-note-swipe': 'open' });
    expect(swipe.props.style.background).toBeUndefined();
    const reveal = swipe.findAll((node) => node.type === 'div' && node.props.style?.background === 'var(--proto-danger)');
    expect(reveal).toHaveLength(1);
    expect(reveal[0].props.style.width).toBe(0);
    expect(reveal[0].findByType('button').props.disabled).toBe(true);
    tree.unmount();
  });

  it('labels hook groups in sentence case', () => {
    for (const key of ['hookGroupAgent', 'hookGroupCc', 'hookGroupPi', 'hookGroupCortex', 'hookGroupOther'] as const) {
      expect(en[key]).not.toBe(en[key].toUpperCase());
    }
  });
});
