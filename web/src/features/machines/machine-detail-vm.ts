import type { MachineDetail, MachineGpu, MachineLiveRun, MachineVitals } from '@cortex-agent/ui-contract';
import { formatSpan, formatSpanPrecise, type TimeLang } from '@/lib/time-format';

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
  /** Heaviest processes only — a busy host can report dozens on one card. */
  processes: MachineGpuProcessRow[];
  hiddenProcessCount: number;
}

export interface MachineRunRow {
  key: string;
  label: string;
  taskId: string | null;
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

/** `45s / 12m / 3h 5m / 2d 3h` · `45秒 / 12分钟 / 3小时5分 / 2天3小时`. */
// Uptime reads coarse: whole minutes under an hour's worth of detail, then day + hour.
function coarseDuration(totalSec: number, lang: TimeLang): string {
  if (totalSec < 0) return '';
  if (totalSec < 3600) return formatSpan(totalSec * 1000, lang);
  return formatSpanPrecise(Math.floor(totalSec / 60) * 60_000, lang);
}

export function formatUptime(sec: number | null, lang: TimeLang): string {
  return sec === null ? '' : coarseDuration(sec, lang);
}

export function formatSince(iso: string | null, lang: TimeLang, now: number = Date.now()): string {
  if (!iso) return '';
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return '';
  return coarseDuration(Math.floor((now - started) / 1000), lang);
}

function buildMeters(vitals: MachineVitals | null, lang: TimeLang): MachineMeter[] {
  if (!vitals) return [];
  const meters: MachineMeter[] = [];
  const { cpuCores, loadAvg1, memUsedMb, memTotalMb, diskFreeGb, diskTotalGb } = vitals;
  if (cpuCores !== null && loadAvg1 !== null) {
    meters.push({ key: 'cpu', label: 'CPU', percent: pct(loadAvg1, cpuCores), text: `${loadAvg1.toFixed(2)} / ${cpuCores}` });
  }
  if (memUsedMb !== null && memTotalMb !== null) {
    meters.push({ key: 'mem', label: lang === 'zh' ? '内存' : 'RAM', percent: pct(memUsedMb, memTotalMb), text: `${gb(memUsedMb)} / ${gb(memTotalMb)} GB` });
  }
  if (diskFreeGb !== null && diskTotalGb !== null) {
    meters.push({ key: 'disk', label: lang === 'zh' ? '磁盘' : 'DISK', percent: pct(diskTotalGb - diskFreeGb, diskTotalGb), text: lang === 'zh' ? `剩余 ${diskFreeGb.toFixed(1)} GB` : `${diskFreeGb.toFixed(1)} GB free` });
  }
  return meters;
}

function runLabel(run: MachineLiveRun): string {
  return run.taskId ?? run.executionId;
}

function buildGpuRow(gpu: MachineGpu): MachineGpuRow {
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
    processes: ranked.slice(0, MAX_PROCESS_ROWS).map((proc) => ({
      pid: proc.pid,
      name: proc.name.split(/[/\\]/).pop() || proc.name,
      memText: `${gb(proc.memoryMb)} GB`,
    })),
    hiddenProcessCount: Math.max(0, ranked.length - MAX_PROCESS_ROWS),
  };
}

/** Map the machines.detail DTO into render slots. No fabrication: absent probe fields drop their row. */
export function buildMachineDetailVm(detail: MachineDetail, lang: TimeLang, now: number = Date.now()): MachineDetailVm {
  return {
    meters: buildMeters(detail.vitals, lang),
    gpus: detail.gpus.map((gpu) => buildGpuRow(gpu)),
    liveRuns: detail.liveRuns.map((run) => ({
      key: run.executionId,
      label: runLabel(run),
      taskId: run.taskId,
      duration: formatSince(run.startedAt, lang, now),
    })),
    probeError: detail.probeError,
  };
}
