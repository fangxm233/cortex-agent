import { describe, expect, it } from 'vitest';
import type { MachineDetail } from '@cortex-agent/ui-contract';
import { buildMachineDetailVm } from './machine-detail-vm';

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
    expect(cpu?.percent).toBe(25);
  });

  it('clamps CPU percent at 100 when load exceeds core count', () => {
    const vm = buildMachineDetailVm(detail({ vitals: { ...detail().vitals!, loadAvg1: 128 } }));
    expect(vm.meters.find((m) => m.key === 'cpu')!.percent).toBe(100);
  });

  it('derives memory and disk used-share percentages', () => {
    const vm = buildMachineDetailVm(detail());
    expect(vm.meters.find((m) => m.key === 'mem')?.percent).toBe(23);
    expect(vm.meters.find((m) => m.key === 'disk')?.percent).toBe(50);
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

const gpus = [
  {
    index: 0, name: 'NVIDIA RTX 6000 Ada Generation', utilPercent: 62,
    memUsedMb: 24576, memTotalMb: 49152, tempC: 71, powerW: 280,
    processes: [{ pid: '41233', name: '/usr/bin/python3', memoryMb: 24000 }],
  },
  {
    index: 1, name: 'NVIDIA RTX 6000 Ada Generation', utilPercent: 0,
    memUsedMb: 4, memTotalMb: 49152, tempC: 38, powerW: 21, processes: [],
  },
];

describe('gpu rows', () => {
  it('maps utilisation and memory percentages for each card', () => {
    expect(buildMachineDetailVm(detail({ gpus })).gpus[0]).toMatchObject({
      index: 0,
      utilPercent: 62,
      memPercent: 50,
    });
  });
});

describe('gpu processes', () => {
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
