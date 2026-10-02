import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useStarredGroups } from '@/features/session/list/useStarredGroups';
import { MSessionListView } from './MSessionListView';
import type { MSessionRow } from './m-session-list-vm';

const row = (id: string): MSessionRow => ({
  id, title: `Renamed ${id}`, time: '1h', unread: false, status: { kind: 'idle', text: 'Idle' },
});
const onOpen = vi.fn();

function List({ projectId, stars = true }: { projectId: string; stars?: boolean }) {
  const groups = useStarredGroups();
  return <MSessionListView rows={[row(`${projectId}-plain`)]}
    stars={{ projectId, rows: stars ? [row(`${projectId}-star`)] : [],
      expanded: !groups.collapsed.has(projectId), onToggle: () => groups.toggle(projectId) }}
    copy={{ title: 'Sessions', empty: 'No sessions' }} presence="connected"
    newLabel="New" onNew={() => {}} onOpen={onOpen} />;
}

const sessionIds = (tree: ReactTestRenderer) => tree.root
  .findAll(n => n.type === 'div' && n.props['data-session-id']).map(n => n.props['data-session-id']);

describe('mobile project Stars', () => {
  it('collapses and expands without hiding ordinary rows or sharing another project’s collapse', () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<List projectId="alpha" />); });
    expect(sessionIds(tree)).toEqual(['alpha-star', 'alpha-plain']);
    const header = () => tree.root.findByProps({ 'aria-label': 'Stars' });
    expect(header().props['aria-expanded']).toBe(true);
    act(() => tree.root.findByProps({ 'data-session-id': 'alpha-star' }).props.onClick());
    expect(onOpen).toHaveBeenCalledWith('alpha-star');
    act(() => header().props.onClick());
    expect(header().props['aria-expanded']).toBe(false);
    expect(sessionIds(tree)).toEqual(['alpha-plain']);
    act(() => tree.update(<List projectId="beta" />));
    expect(sessionIds(tree)).toEqual(['beta-star', 'beta-plain']);
    act(() => tree.update(<List projectId="alpha" />));
    expect(sessionIds(tree)).toEqual(['alpha-plain']);
    act(() => header().props.onClick());
    expect(sessionIds(tree)).toEqual(['alpha-star', 'alpha-plain']);
    act(() => tree.unmount());
  });

  it('hides empty star groups, including after the last star is removed', () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<List projectId="alpha" />); });
    act(() => tree.update(<List projectId="alpha" stars={false} />));
    expect(tree.root.findAllByProps({ 'aria-label': 'Stars' })).toHaveLength(0);
    expect(sessionIds(tree)).toEqual(['alpha-plain']);
    act(() => tree.unmount());
  });

  it('does not show the empty-list message while all rows are collapsed stars', () => {
    const tree = create(<MSessionListView rows={[]} stars={{ projectId: 'alpha', rows: [row('star')],
      expanded: false, onToggle: () => {} }} copy={{ title: 'Sessions', empty: 'No sessions' }}
      presence="connected" newLabel="New" onNew={() => {}} onOpen={onOpen} />);
    expect(JSON.stringify(tree.toJSON())).not.toContain('No sessions');
    expect(sessionIds(tree)).toEqual([]);
    act(() => tree.unmount());
  });
});
