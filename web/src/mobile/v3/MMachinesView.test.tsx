import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { MMachinesView, type MMachinesCopy } from './MMachinesView';
import { buildMMachinesVm } from './m-machines-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

const copy: MMachinesCopy = {
  title: '机器',
  online: '在线',
  offline: '离线',
  hb: '心跳',
  lastHb: '上次心跳',
  gpu: 'GPU',
  running: '运行中',
  daemon: 'daemon',
  onlineWord: '在线',
  retry: '重试连接',
  logs: '查看日志',
  registered: '台注册',
  editDesktop: '编辑走桌面设置',
  empty: '暂无机器',
};

function mk(p: Partial<MachineInfo> & { name: string }): MachineInfo {
  return {
    name: p.name,
    cortexPath: '/home/user/.cortex',
    gpuCount: p.gpuCount ?? null,
    sshConfigured: true,
    os: p.os ?? 'unix',
    online: p.online ?? false,
    connectedAt: p.connectedAt ?? null,
    lastHeartbeat: p.lastHeartbeat ?? null,
    capabilities: [],
    liveRuns: p.liveRuns ?? 0,
  };
}

function render(machines: MachineInfo[]) {
  const vm = buildMMachinesVm(machines, NOW);
  return renderToStaticMarkup(<MMachinesView vm={vm} copy={copy} onBack={() => {}} />);
}

const atlas = mk({
  name: 'atlas',
  online: true,
  gpuCount: 2,
  liveRuns: 2,
  lastHeartbeat: new Date(NOW - 30_000).toISOString(),
});
const nimbus = mk({ name: 'nimbus', online: false, os: 'windows' });

describe('MMachinesView', () => {
  it('renders the drill header title and the real daemon N/M online status', () => {
    const html = render([atlas, nimbus]);
    expect(html).toContain('机器');
    expect(html).toContain('daemon');
    expect(html).toContain('1/2');
  });

  it('renders an online card: name, 在线 pill, heartbeat, honest GPU count, running row', () => {
    const html = render([atlas]);
    expect(html).toContain('atlas');
    expect(html).toContain('在线');
    expect(html).toContain('心跳');
    expect(html).toContain('30s 前');
    expect(html).toContain('2 GPU'); // honest gpuCount, not util bars
    expect(html).toContain('2 运行中'); // real liveRuns
    expect(html).toContain('#4655D4'); // running pulse dot
  });

  it('renders an offline card: 离线 pill, honest — heartbeat, and inert retry/logs buttons', () => {
    const html = render([nimbus]);
    expect(html).toContain('nimbus');
    expect(html).toContain('离线');
    expect(html).toContain('上次心跳');
    expect(html).toContain('—'); // no lastHeartbeat when offline
    expect(html).toContain('重试连接');
    expect(html).toContain('查看日志');
  });

  it('does NOT fabricate the scheme mocks (client version, per-GPU util/VRAM bars)', () => {
    const html = render([atlas]);
    expect(html).not.toContain('client v');
    expect(html).not.toContain('4090');
    expect(html).not.toContain('82%');
    expect(html).not.toContain('18.2G');
  });

  it('renders the footer registry line', () => {
    const html = render([atlas, nimbus]);
    expect(html).toContain('machines.json');
    expect(html).toContain('2 台注册');
    expect(html).toContain('编辑走桌面设置');
  });

  it('shows the empty state when there are no machines', () => {
    const html = render([]);
    expect(html).toContain('暂无机器');
  });
});
