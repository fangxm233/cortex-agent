import { act, create } from 'react-test-renderer';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MachinesMenu } from './MachinesMenu';

const roster = vi.hoisted(() => ({
  machines: [] as MachineInfo[], loading: false, error: null as Error | null,
}));
vi.mock('./useMachinesResource', () => ({ useMachinesResource: () => roster }));
vi.mock('./MachineList', () => ({ MachineList: () => null }));
vi.mock('@/i18n', () => ({ useVocab: () => ({ machines: 'Machines' }), useLang: () => 'en' }));

function machine(online: boolean, index: number): MachineInfo {
  return {
    name: `machine-${index}`, cortexPath: null, gpuCount: null, sshConfigured: false,
    os: 'unix', online, connectedAt: null, lastHeartbeat: null, capabilities: [],
  };
}

beforeEach(() => Object.assign(roster, { machines: [], loading: false, error: null }));

describe('MachinesMenu trigger', () => {
  it.each([
    { state: 'all online', online: [true, true], label: '2/2', loading: false, error: null },
    { state: 'some offline', online: [true, false], label: '1/2', loading: false, error: null },
    { state: 'all offline', online: [false, false], label: '0/2', loading: false, error: null },
    { state: 'empty', online: [], label: '0/0', loading: false, error: null },
    { state: 'loading', online: [], label: '—', loading: true, error: null },
    { state: 'failed', online: [true, false], label: '—', loading: false, error: new Error('offline') },
  ])('keeps the icon and count without a status dot when $state', ({ online, label, loading, error }) => {
    Object.assign(roster, { machines: online.map(machine), loading, error });
    const view = create(<MachinesMenu onManage={vi.fn()} />);
    const button = view.root.findByProps({ 'data-machines-menu': '' });
    expect(button.props['aria-label']).toBe(`Machines · ${label}`);
    expect(button.props.title).toBe(`Machines · ${label}`);
    expect(button.findAllByType('svg')).toHaveLength(1);
    expect(button.findAll((node) => node.props['data-machines-tone'] !== undefined)).toHaveLength(0);
    expect(button.findAllByType('span').map((node) => node.children.join(''))).toEqual([label]);
    act(() => view.unmount());
  });
});
