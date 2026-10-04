import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MC, MCard, MGroupLabel, MPill, MScreen, MScrollBody, MTabHeader } from '../ui/kit';
import type { MSessionRow } from './m-session-list-vm';
import { MSessionListView, type MSessionListCopy } from './MSessionListView';

const noop = () => {};
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

  it('keeps only the title header and scheduled entry above sessions, new session in thumb reach', () => {
    const onNew = () => {};
    const tree = create(<MSessionListView rows={[]} copy={sessionCopy} presence="connected"
      newLabel="New" scheduled={{ unread: 2, onOpen: noop }} onOpen={noop} onNew={onNew} />);
    const screen = tree.root.findByType(MScreen);
    expect(screen.findByType(MTabHeader).props.title).toBe('Sessions');
    expect(tree.root.findByProps({ 'aria-label': 'Scheduled' }).props.onClick).toBe(noop);
    expect(tree.root.findByProps({ 'aria-label': '2 unread scheduled' })).toBeTruthy();
    expect(screen.props.overlay.props).toMatchObject({ 'aria-label': 'New', onClick: onNew });
    tree.unmount();
  });

  it('opens the Projects panel from the brand mark, which carries the amber pending count', () => {
    const onProjects = vi.fn();
    const view = (needsYou: number) => create(<MSessionListView rows={[]} copy={sessionCopy} presence="connected"
      projects={{ needsYou, onOpen: onProjects }} newLabel="New" onOpen={noop} onNew={noop} />);
    const pending = view(3);
    const button = pending.root.findByProps({ 'data-projects-button': '' });
    expect(button.props['aria-label']).toBe('Projects, 3 need you');
    expect(button.findAll((node) => node.type === 'span' && node.props.style?.background === 'var(--proto-amber)')
      .map((node) => node.children.join(''))).toEqual(['3']);
    act(() => button.props.onClick());
    expect(onProjects).toHaveBeenCalledOnce();
    const quiet = view(0);
    const plain = quiet.root.findByProps({ 'data-projects-button': '' });
    expect(plain.props['aria-label']).toBe('Projects');
    expect(plain.findAll((node) => node.type === 'span' && node.props.style?.background === 'var(--proto-amber)')).toHaveLength(0);
    pending.unmount();
    quiet.unmount();
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
});
