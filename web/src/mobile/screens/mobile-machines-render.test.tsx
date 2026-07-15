import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { en, zh } from '@/i18n';
import { MobileMachinesView } from './MobileMachinesScreen';
import { buildMobileMachinesVm } from './mobile-machines-vm';
import type { MachineInfo } from '@cortex-agent/ui-contract';

// Render tests for MobileMachinesView (pure presentational; no tRPC / QueryClient providers).
// Tests cover: screen marker, status-bar gutter, title, online dot, liveRuns badge, GPU label,
// OS badge, empty state, and the online/total count badge.

const NOW = new Date('2026-07-10T12:00:00Z').getTime();

function mk(p: Partial<MachineInfo> & { name: string }): MachineInfo {
  return {
    name: p.name,
    cortexPath: p.cortexPath ?? null,
    gpuCount: p.gpuCount ?? null,
    sshConfigured: p.sshConfigured ?? true,
    os: p.os ?? 'unix',
    online: p.online ?? false,
    connectedAt: p.connectedAt ?? null,
    lastHeartbeat: p.lastHeartbeat ?? null,
    capabilities: p.capabilities ?? [],
    liveRuns: p.liveRuns ?? 0,
  };
}

function view(machines: MachineInfo[], vocab = en) {
  const cards = buildMobileMachinesVm(machines);
  return renderToStaticMarkup(<MobileMachinesView cards={cards} vocab={vocab} now={NOW} />);
}

const seed: MachineInfo[] = [
  mk({
    name: 'lab2',
    online: true,
    liveRuns: 2,
    gpuCount: 2,
    os: 'unix',
    connectedAt: new Date(NOW - 5 * 60_000).toISOString(),
  }),
  mk({ name: 'my-pc', online: false, liveRuns: 0, os: 'windows' }),
];

describe('MobileMachinesView', () => {
  it('renders screen marker and reserves the status-bar gutter', () => {
    const html = view(seed);
    expect(html).toContain('data-screen-label="machines"');
    expect(html).toContain('padding-top:env(safe-area-inset-top)');
  });

  it('renders the title from vocab (en)', () => {
    const html = view(seed, en);
    expect(html).toContain(en.machines); // 'Machines'
  });

  it('renders the title from vocab (zh)', () => {
    const html = view(seed, zh);
    expect(html).toContain(zh.machines); // '机器'
  });

  it('renders the online/total count badge', () => {
    const html = view(seed);
    // 1 online out of 2 total
    expect(html).toContain('1 / 2');
  });

  it('renders an online dot for the online machine', () => {
    const html = view(seed);
    expect(html).toContain('data-machine-dot="online"');
  });

  it('renders an offline dot for the offline machine', () => {
    const html = view(seed);
    expect(html).toContain('data-machine-dot="offline"');
  });

  it('renders machine names', () => {
    const html = view(seed);
    expect(html).toContain('lab2');
    expect(html).toContain('my-pc');
  });

  it('renders OS badges', () => {
    const html = view(seed);
    expect(html).toContain('unix');
    expect(html).toContain('windows');
  });

  it('renders the liveRuns badge only for machines with liveRuns > 0', () => {
    const html = view(seed);
    expect(html).toContain('2');
    expect(html).toContain(en.mLiveRuns); // 'live'
  });

  it('does not render liveRuns badge when liveRuns is 0', () => {
    const html = view([mk({ name: 'idle', online: false, liveRuns: 0 })]);
    expect(html).not.toContain(en.mLiveRuns);
  });

  it('renders GPU count for machines that have gpuCount set', () => {
    const html = view(seed);
    expect(html).toContain('2');
    expect(html).toContain(en.mGpu); // 'GPU'
  });

  it('omits GPU label when gpuCount is null', () => {
    const html = view([mk({ name: 'x', online: false, gpuCount: null })]);
    expect(html).not.toContain(en.mGpu);
  });

  it('renders the online status label for online machine', () => {
    const html = view(seed, en);
    expect(html).toContain(en.mOnline); // 'online'
  });

  it('renders the offline status label for offline machine', () => {
    const html = view(seed, en);
    expect(html).toContain(en.mOffline); // 'offline'
  });

  it('renders connected-since for the online machine', () => {
    // lab2 connected 5 minutes ago → "5m 前"
    const html = view(seed);
    expect(html).toContain('5m 前');
  });

  it('does not show connected-since for offline machines', () => {
    // Only offline machine: my-pc — its sub-line should not carry a timestamp
    const offlineOnly = view([mk({ name: 'my-pc', online: false })]);
    expect(offlineOnly).not.toContain('前');
  });

  it('renders the empty state when there are no machines', () => {
    const html = view([], en);
    expect(html).toContain(en.mNoMachines);
    // count badge shows "0 / 0"
    expect(html).toContain('0 / 0');
  });

  it('renders the home-indicator spacer (28px)', () => {
    const html = view(seed);
    expect(html).toContain('height:28px');
  });
});
