// input:  machines view-model, expand panel state, machines copy
// output: collapsed vs expanded machine card rendering regressions
// pos:    Verifies the mobile Machines expand panel gating
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MachineDetail } from '@cortex-agent/ui-contract';
import { buildMachineDetailVm } from '@/features/workbench/machine-detail-vm';
import { MMachinesView, type MMachinesCopy, type MMachineDetailPanel } from './MMachinesView';
import type { MMachinesVm } from './m-machines-vm';

const copy: MMachinesCopy = {
  title: 'Machines', online: 'Online', offline: 'Offline', hb: 'HB', lastHb: 'last HB',
  gpu: 'GPU', running: 'running', daemon: 'daemon', onlineWord: 'online', retry: 'Retry',
  logs: 'Logs', registered: 'registered', editDesktop: 'edit on desktop', empty: 'No machines',
  probing: 'Probing…', probeFailed: 'Probe failed', noGpu: 'No GPU reported',
  offlineNoTelemetry: 'Offline — no live telemetry', up: 'up', uptime: 'uptime', path: 'path',
};

const vm: MMachinesVm = {
  cards: [
    {
      name: 'atlas', online: true, os: 'unix', gpuCount: 2, liveRuns: 1, heartbeat: '3s 前',
      connectedFor: '3h 0m', capabilities: ['rg'], cortexPath: '/srv/.cortex', sshConfigured: true,
    },
    {
      name: 'nimbus', online: false, os: 'unix', gpuCount: null, liveRuns: 0, heartbeat: '—',
      connectedFor: '', capabilities: [], cortexPath: '/srv/.cortex', sshConfigured: false,
    },
  ],
  onlineCount: 1,
  total: 2,
};

const detail: MachineDetail = {
  name: 'atlas',
  online: true,
  vitals: { cpuCores: 64, loadAvg1: 16, memUsedMb: 61440, memTotalMb: 262144, diskFreeGb: 500, diskTotalGb: 1000, uptimeSec: 123456 },
  gpus: [{
    index: 0, name: 'NVIDIA RTX 6000 Ada Generation', utilPercent: 62,
    memUsedMb: 24576, memTotalMb: 49152, tempC: 71, powerW: 280, processes: [],
  }],
  liveRuns: [{ executionId: 'e1', taskId: 'a3f1', runName: 'exp-042', project: 'p', gpuIndices: [0], startedAt: null }],
  probedAt: '2026-08-03T12:00:00.000Z',
  probeError: null,
};

function markup(expanded: string | null, panel: MMachineDetailPanel | null) {
  return renderToStaticMarkup(
    <MMachinesView vm={vm} copy={copy} onBack={() => {}} expanded={expanded} onToggle={() => {}} panel={panel} />,
  );
}

const readyPanel: MMachineDetailPanel = { status: 'ready', vm: buildMachineDetailVm(detail), uptime: '1d 10h' };

describe('MMachinesView expand panel', () => {
  it('renders no telemetry while every card is collapsed', () => {
    const html = markup(null, null);
    expect(html).toContain('atlas');
    expect(html).not.toContain('RTX 6000 Ada');
    expect(html).not.toContain('exp-042');
  });

  it('renders GPU telemetry, live runs and statics for the expanded card only', () => {
    const html = markup('atlas', readyPanel);
    expect(html).toContain('RTX 6000 Ada');
    expect(html).toContain('62%');
    expect(html).toContain('24.0 / 48.0 GB');
    expect(html).toContain('exp-042');
    expect(html).toContain('1d 10h');
    expect(html).toContain('/srv/.cortex');
  });

  it('shows the probing notice before the first probe returns', () => {
    const html = markup('atlas', { status: 'probing', vm: null, uptime: '' });
    expect(html).toContain('Probing…');
    expect(html).not.toContain('RTX 6000 Ada');
  });

  it('shows the failure notice instead of blank telemetry when the probe fails', () => {
    const html = markup('atlas', { status: 'error', vm: null, uptime: '' });
    expect(html).toContain('Probe failed');
  });

  it('reports a probe error carried inside a successful response', () => {
    const failed = buildMachineDetailVm({ ...detail, gpus: [], vitals: null, probeError: 'nvidia-smi missing' });
    const html = markup('atlas', { status: 'ready', vm: failed, uptime: '' });
    expect(html).toContain('nvidia-smi missing');
  });

  it('tells an expanded offline machine apart from a failed probe', () => {
    const html = markup('nimbus', null);
    expect(html).toContain('Offline — no live telemetry');
    expect(html).not.toContain('Probe failed');
  });
});
