// input:  MachineDetail DTO (machines.detail live probe)
// output: buildMachineDetailVm + formatSince/formatUptime/shortenGpuName
// pos:    pure view-model for the expanded machine card, shared by desktop and mobile
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { MachineDetail, MachineGpu, MachineLiveRun, MachineVitals } from '@cortex-agent/ui-contract';

export interface MachineMeter {
  key: 'cpu' | 'mem' | 'disk';
  label: string;
  /** Bar fill 0-100. */
  percent: number;
  text: string;
}

export interface MachineGpuProcessRow {
  pid: string;
  name: string;
  memText: string;
}

export interface MachineGpuRow {
  index: number;
  name: string;
  utilPercent: number;
  utilText: string;
  memPercent: number;
  memText: string;
  tempText: string;
  powerText: string;
  /** Cortex runs holding this ordinal (from ExecutionGpuInfo); [] when nothing recorded it. */
  owners: string[];
  /** Heaviest processes only — a busy host can report dozens on one card. */
  processes: MachineGpuProcessRow[];
  hiddenProcessCount: number;
}

export interface MachineRunRow {
  key: string;
  label: string;
  taskId: string | null;
  /** 'GPU 0,2'; empty when the run's ordinals were never recorded. */
  gpuText: string;
  duration: string;
}

export interface MachineDetailVm {
  meters: MachineMeter[];
  gpus: MachineGpuRow[];
  liveRuns: MachineRunRow[];
  probeError: string | null;
}

const MB_PER_GB = 1024;
const MAX_PROCESS_ROWS = 5;

function pct(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((part / whole) * 100)));
}

function gb(mb: number): string {
  return (mb / MB_PER_GB).toFixed(1);
}

/** Drop vendor prefixes that repeat on every row and carry no information. */
export function shortenGpuName(name: string): string {
  return name
    .replace(/^NVIDIA\s+/i, '')
    .replace(/^GeForce\s+/i, '')
    .replace(/\s+Generation$/i, '')
    .trim();
}

function coarseDuration(totalSec: number): string {
  if (totalSec < 0) return '';
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatUptime(sec: number | null): string {
  return sec === null ? '' : coarseDuration(sec);
}

export function formatSince(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return '';
  return coarseDuration(Math.floor((now - started) / 1000));
}

function buildMeters(vitals: MachineVitals | null): MachineMeter[] {
  if (!vitals) return [];
  const meters: MachineMeter[] = [];
  const { cpuCores, loadAvg1, memUsedMb, memTotalMb, diskFreeGb, diskTotalGb } = vitals;
  if (cpuCores !== null && loadAvg1 !== null) {
    meters.push({ key: 'cpu', label: 'CPU', percent: pct(loadAvg1, cpuCores), text: `${loadAvg1.toFixed(2)} / ${cpuCores}` });
  }
  if (memUsedMb !== null && memTotalMb !== null) {
    meters.push({ key: 'mem', label: 'RAM', percent: pct(memUsedMb, memTotalMb), text: `${gb(memUsedMb)} / ${gb(memTotalMb)} GB` });
  }
  if (diskFreeGb !== null && diskTotalGb !== null) {
    meters.push({ key: 'disk', label: 'DISK', percent: pct(diskTotalGb - diskFreeGb, diskTotalGb), text: `${diskFreeGb.toFixed(1)} GB free` });
  }
  return meters;
}

function runLabel(run: MachineLiveRun): string {
  return run.runName ?? run.taskId ?? run.executionId;
}

function buildGpuRow(gpu: MachineGpu, liveRuns: MachineLiveRun[]): MachineGpuRow {
  const ranked = [...gpu.processes].sort((a, b) => b.memoryMb - a.memoryMb);
  return {
    index: gpu.index,
    name: shortenGpuName(gpu.name),
    utilPercent: Math.min(100, Math.max(0, gpu.utilPercent)),
    utilText: `${gpu.utilPercent}%`,
    memPercent: pct(gpu.memUsedMb, gpu.memTotalMb),
    memText: `${gb(gpu.memUsedMb)} / ${gb(gpu.memTotalMb)} GB`,
    tempText: `${gpu.tempC}°C`,
    powerText: `${gpu.powerW}W`,
    owners: liveRuns.filter((run) => run.gpuIndices.includes(gpu.index)).map(runLabel),
    processes: ranked.slice(0, MAX_PROCESS_ROWS).map((proc) => ({
      pid: proc.pid,
      name: proc.name.split(/[/\\]/).pop() || proc.name,
      memText: `${gb(proc.memoryMb)} GB`,
    })),
    hiddenProcessCount: Math.max(0, ranked.length - MAX_PROCESS_ROWS),
  };
}

/** Map the machines.detail DTO into render slots. No fabrication: absent probe fields drop their row. */
export function buildMachineDetailVm(detail: MachineDetail, now: number = Date.now()): MachineDetailVm {
  return {
    meters: buildMeters(detail.vitals),
    gpus: detail.gpus.map((gpu) => buildGpuRow(gpu, detail.liveRuns)),
    liveRuns: detail.liveRuns.map((run) => ({
      key: run.executionId,
      label: runLabel(run),
      taskId: run.taskId,
      gpuText: run.gpuIndices.length > 0 ? `GPU ${run.gpuIndices.join(',')}` : '',
      duration: formatSince(run.startedAt, now),
    })),
    probeError: detail.probeError,
  };
}
