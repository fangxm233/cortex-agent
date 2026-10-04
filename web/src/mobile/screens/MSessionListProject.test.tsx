import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MSessionListView } from './MSessionListView';
import { MProjectSwitchSheetView } from './MProjectSwitchSheet';
import type { MProjectSwitchRow } from './m-project-vm';

vi.mock('@/mobile/ui/kit', async (load) => ({
  ...(await load<typeof import('@/mobile/ui/kit')>()),
  MBottomSheet: ({ children }: { children: unknown }) => <div data-bottom-sheet>{children as never}</div>,
}));

const noop = () => {};
const projectRow = (id: string): MProjectSwitchRow => ({
  id, initials: id.slice(0, 2).toUpperCase(), todayCost: null, badgeCount: 0, badgeTone: 'unread',
});

describe('mobile session list project title', () => {
  it('titles the list with the current project and opens the switcher from it', () => {
    const onSwitch = vi.fn();
    const tree = create(<MSessionListView rows={[]} presence="connected" newLabel="New"
      project={{ name: 'dex-hand', switchLabel: 'Switch project', onSwitch }} onOpen={noop} onNew={noop} />);
    const title = tree.root.findByProps({ 'aria-label': 'Switch project: dex-hand' });
    expect(JSON.stringify(tree.toJSON())).not.toContain('"Sessions"');
    act(() => title.props.onClick());
    expect(onSwitch).toHaveBeenCalledOnce();
    tree.unmount();
  });

  it('falls back to the list title while the project is unresolved', () => {
    const tree = create(<MSessionListView rows={[]} presence="connected" newLabel="New"
      project={{ name: null, switchLabel: 'Switch project', onSwitch: noop }} onOpen={noop} onNew={noop} />);
    expect(tree.root.findByProps({ 'aria-label': 'Switch project: Sessions' })).toBeTruthy();
    tree.unmount();
  });

  it('marks the current project first and switches on another row', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const onNewProject = vi.fn();
    const tree = create(<MProjectSwitchSheetView current={projectRow('general')}
      others={[projectRow('dex-hand'), projectRow('cortex-self')]} onPick={onPick} onNewProject={onNewProject} onClose={onClose} />);
    const rows = tree.root.findAll((node) => node.type === 'div' && node.props['data-project-id']);
    expect(rows.map((row) => row.props['data-project-id'])).toEqual(['general', 'dex-hand', 'cortex-self']);
    expect(rows[0].props['aria-current']).toBe(true);
    act(() => rows[0].props.onClick());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
    act(() => rows[1].props.onClick());
    expect(onPick).toHaveBeenCalledWith('dex-hand');
    tree.unmount();
  });
});
