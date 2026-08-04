import { describe, expect, it } from 'vitest';
import type { MachineDetail } from '@cortex-agent/ui-contract';
import { buildMachineDetailVm, formatSince, formatUptime, shortenGpuName } from './machine-detail-vm';

function detail(over: Partial<MachineDetail> = {}): MachineDetail {
  return {
    name: 'atlas',
    online: true,
    vitals: {
      cpuCores: 64,
      loadAvg1: 16,
      memUsedMb: 61440,
      memTotalMb: 262144,
      diskFreeGb: 500,
      diskTotalGb: 1000,
      uptimeSec: 123456,
    },
    gpus: [],
    liveRuns: [],
    probedAt: '2026-08-03T12:00:00.000Z',
    probeError: null,
    ...over,
  };
}

describe('meters', () => {
  it('derives CPU load as a percentage of core count', () => {
    const cpu = buildMachineDetailVm(detail()).meters.find((m) => m.key === 'cpu');
    expect(cpu).toMatchObject({ label: 'CPU', percent: 25, text: '16.00 / 64' });
  });

  it('clamps CPU percent at 100 when load exceeds core count', () => {
    const vm = buildMachineDetailVm(detail({ vitals: { ...detail().vitals!, loadAvg1: 128 } }));
    expect(vm.meters.find((m) => m.key === 'cpu')!.percent).toBe(100);
  });

  it('reports memory and disk in GB with used-share percentages', () => {
    const vm = buildMachineDetailVm(detail());
    expect(vm.meters.find((m) => m.key === 'mem')).toMatchObject({ percent: 23, text: '60.0 / 256.0 GB' });
    expect(vm.meters.find((m) => m.key === 'disk')).toMatchObject({ percent: 50, text: '500.0 GB free' });
  });

  it('omits a meter whose inputs the host did not report', () => {
    const vm = buildMachineDetailVm(
      detail({ vitals: { ...detail().vitals!, cpuCores: null, diskTotalGb: null, diskFreeGb: null } }),
    );
    expect(vm.meters.map((m) => m.key)).toEqual(['mem']);
  });

  it('yields no meters at all when the probe produced no vitals', () => {
    expect(buildMachineDetailVm(detail({ vitals: null })).meters).toEqual([]);
  });
});

describe('gpu rows', () => {
  const gpus = [
    {
      index: 0,
      name: 'NVIDIA RTX 6000 Ada Generation',
      utilPercent: 62,
      memUsedMb: 24576,
      memTotalMb: 49152,
      tempC: 71,
      powerW: 280,
      processes: [{ pid: '41233', name: '/usr/bin/python3', memoryMb: 24000 }],
    },
    {
      index: 1,
      name: 'NVIDIA RTX 6000 Ada Generation',
      utilPercent: 0,
      memUsedMb: 4,
      memTotalMb: 49152,
      tempC: 38,
      powerW: 21,
      processes: [],
    },
  ];

  it('formats utilisation, memory, temperature and power for each card', () => {
    const row = buildMachineDetailVm(detail({ gpus })).gpus[0];
    expect(row).toMatchObject({
      index: 0,
      name: 'RTX 6000 Ada',
      utilPercent: 62,
      utilText: '62%',
      memPercent: 50,
      memText: '24.0 / 48.0 GB',
      tempText: '71°C',
      powerText: '280W',
    });
  });

  it('labels a GPU with the runs that acquired it', () => {
    const liveRuns = [
      { executionId: 'e1', taskId: 'a3f1', runName: 'exp-042', project: 'p', gpuIndices: [0], startedAt: null },
      { executionId: 'e2', taskId: 'bbbb', runName: null, project: 'p', gpuIndices: [0, 1], startedAt: null },
    ];
    const vm = buildMachineDetailVm(detail({ gpus, liveRuns }));
    expect(vm.gpus[0].owners).toEqual(['exp-042', 'bbbb']);
    // a multi-GPU run claims every ordinal it holds
    expect(vm.gpus[1].owners).toEqual(['bbbb']);
  });

  it('leaves owners empty when no run recorded a GPU index', () => {
    const liveRuns = [
      { executionId: 'e1', taskId: 'a3f1', runName: 'exp-042', project: 'p', gpuIndices: [], startedAt: null },
    ];
    expect(buildMachineDetailVm(detail({ gpus, liveRuns })).gpus[0].owners).toEqual([]);
  });

  it('shows compute processes with basenames and GB memory', () => {
    const vm = buildMachineDetailVm(detail({ gpus }));
    expect(vm.gpus[0].processes).toEqual([{ pid: '41233', name: 'python3', memText: '23.4 GB' }]);
    expect(vm.gpus[0].hiddenProcessCount).toBe(0);
  });

  it('caps a long process list to the heaviest few and counts the remainder', () => {
    // A desktop host can report dozens of processes on one card; the row must stay bounded.
    const many = Array.from({ length: 9 }, (_, i) => ({
      pid: String(100 + i), name: `p${i}`, memoryMb: (i + 1) * 1024,
    }));
    const vm = buildMachineDetailVm(detail({ gpus: [{ ...gpus[0], processes: many }] }));

    expect(vm.gpus[0].processes.map((p) => p.pid)).toEqual(['108', '107', '106', '105', '104']);
    expect(vm.gpus[0].hiddenProcessCount).toBe(4);
  });
});

describe('live runs', () => {
  it('labels a run by run name and the GPUs it holds', () => {
    const vm = buildMachineDetailVm(
      detail({
        liveRuns: [
          {
            executionId: 'e1', taskId: 'a3f1', runName: 'exp-042', project: 'dexhand',
            gpuIndices: [0, 2], startedAt: '2026-08-03T11:00:00.000Z',
          },
        ],
      }),
      Date.parse('2026-08-03T12:30:00.000Z'),
    );
    expect(vm.liveRuns).toEqual([
      { key: 'e1', label: 'exp-042', taskId: 'a3f1', gpuText: 'GPU 0,2', duration: '1h 30m' },
    ]);
  });

  it('falls back to the task id when the run has no name, and blanks unknown GPUs', () => {
    const vm = buildMachineDetailVm(
      detail({
        liveRuns: [
          { executionId: 'e1', taskId: 'a3f1', runName: null, project: null, gpuIndices: [], startedAt: null },
        ],
      }),
    );
    expect(vm.liveRuns[0]).toMatchObject({ label: 'a3f1', gpuText: '', duration: '' });
  });
});

describe('formatters', () => {
  it('shortens vendor noise out of GPU model names', () => {
    expect(shortenGpuName('NVIDIA RTX PRO 6000 Blackwell Workstation Edition')).toBe('RTX PRO 6000 Blackwell Workstation Edition');
    expect(shortenGpuName('NVIDIA GeForce RTX 4090')).toBe('RTX 4090');
    expect(shortenGpuName('NVIDIA RTX 6000 Ada Generation')).toBe('RTX 6000 Ada');
  });

  it('renders uptime at day, hour and minute scale', () => {
    expect(formatUptime(123456)).toBe('1d 10h');
    expect(formatUptime(18720)).toBe('5h 12m');
    expect(formatUptime(2520)).toBe('42m');
    expect(formatUptime(null)).toBe('');
  });

  it('renders elapsed time since an ISO timestamp', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    expect(formatSince('2026-08-03T11:58:30.000Z', now)).toBe('1m');
    expect(formatSince('2026-08-01T12:00:00.000Z', now)).toBe('2d 0h');
    expect(formatSince(null, now)).toBe('');
  });
});

describe('probe status', () => {
  it('surfaces a probe error verbatim', () => {
    const vm = buildMachineDetailVm(detail({ probeError: 'Command timed out after 15s', vitals: null }));
    expect(vm.probeError).toBe('Command timed out after 15s');
  });

  it('reports a GPU-less online host as probed rather than failed', () => {
    const vm = buildMachineDetailVm(detail({ gpus: [] }));
    expect(vm.probeError).toBeNull();
    expect(vm.gpus).toEqual([]);
  });
});
