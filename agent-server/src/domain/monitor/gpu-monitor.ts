import { getMachineRegistry } from '../tasks/dispatch-utils.js';
import { sendCommand, isDeviceOnline } from '../remote/client-manager.js';
import { Icons } from '../../core/icons.js';

type GpuProc = {
  pid: string;
  name: string;
  memoryMB: number;
  gpuUuid: string;
};

type GpuInfo = {
  index: number;
  uuid: string;
  name: string;
  utilPercent: number;
  memUsedMB: number;
  memTotalMB: number;
  tempC: number;
  powerW: number;
  processes: GpuProc[];
};

type GpuSnapshot = {
  machine: string;
  capturedAt: string;
  gpus: GpuInfo[];
};

const GPU_QUERY = 'nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null';
const PROC_QUERY = 'nvidia-smi --query-compute-apps=pid,process_name,used_memory,gpu_uuid --format=csv,noheader,nounits 2>/dev/null || echo ""';
const SPARK_CHARS = '▁▂▃▄▅▆▇█';
let cachedMockRaw: string | null = null;
let cachedMockState: Record<string, unknown> | null = null;

function parseMock(key: 'GPU' | 'PROC') {
  try {
    const raw = process.env.CORTEX_GPU_MONITOR_MOCK;
    if (!raw) {
      cachedMockRaw = null;
      cachedMockState = null;
      return null;
    }
    if (raw !== cachedMockRaw) {
      cachedMockRaw = raw;
      cachedMockState = JSON.parse(raw);
    }
    const value = cachedMockState?.[key];
    if (Array.isArray(value)) return value.shift() ?? '';
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function execGpuCommand(machine: string, command: string, mockKey: 'GPU' | 'PROC') {
  const mocked = parseMock(mockKey);
  if (mocked != null) return mocked;
  const reg = getMachineRegistry()[machine];
  if (!reg) throw new Error(`Unknown machine: ${machine}`);
  if (!isDeviceOnline(machine)) throw new Error(`Device ${machine} is not online`);
  const result = await sendCommand(machine, { action: 'bash', params: { command }, timeout: 15000 });
  return result.stdout || '';
}

function parseGpuLine(line: string): GpuInfo | null {
  const parts = line.split(',').map(part => part.trim());
  if (parts.length < 8) return null;
  return {
    index: parseInt(parts[0], 10),
    uuid: parts[1],
    name: parts[2],
    utilPercent: parseInt(parts[3], 10) || 0,
    memUsedMB: parseInt(parts[4], 10) || 0,
    memTotalMB: parseInt(parts[5], 10) || 0,
    tempC: parseInt(parts[6], 10) || 0,
    powerW: Math.round(parseFloat(parts[7]) || 0),
    processes: [],
  };
}

function parseProcLine(line: string): GpuProc | null {
  const parts = line.split(',').map(part => part.trim());
  if (parts.length < 4) return null;
  return {
    pid: parts[0],
    name: parts[1],
    memoryMB: parseInt(parts[2], 10) || 0,
    gpuUuid: parts[3],
  };
}

async function queryGpuSnapshot(machine: string): Promise<GpuSnapshot> {
  const gpuOutput = await execGpuCommand(machine, GPU_QUERY, 'GPU');
  const procOutput = await execGpuCommand(machine, PROC_QUERY, 'PROC');
  const gpus = gpuOutput
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseGpuLine)
    .filter(Boolean) as GpuInfo[];

  const procMap = new Map<string, GpuProc[]>();
  for (const proc of procOutput.split('\n').map(line => line.trim()).filter(Boolean).map(parseProcLine).filter(Boolean) as GpuProc[]) {
    if (!procMap.has(proc.gpuUuid)) procMap.set(proc.gpuUuid, []);
    procMap.get(proc.gpuUuid)!.push(proc);
  }

  for (const gpu of gpus) {
    gpu.processes = procMap.get(gpu.uuid) || [];
  }

  return {
    machine,
    capturedAt: new Date().toISOString(),
    gpus,
  };
}

function buildBar(percent: number, width = 10) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

function buildSparkline(history: number[]) {
  if (history.length === 0) return '▁';
  return history.map(value => {
    const clamped = Math.max(0, Math.min(100, value));
    const idx = Math.min(SPARK_CHARS.length - 1, Math.floor((clamped / 100) * (SPARK_CHARS.length - 1)));
    return SPARK_CHARS[idx];
  }).join('');
}

function formatGiB(mb: number) {
  return `${(mb / 1024).toFixed(1)} GB`;
}

function renderGpuSnapshot(snapshot: GpuSnapshot, historyByGpu: Map<string, number[]>, refreshSeconds = 5) {
  const lines = [`${Icons.desktop} ${snapshot.machine} · refresh ${refreshSeconds}s`, ''];
  for (const gpu of snapshot.gpus) {
    const history = historyByGpu.get(gpu.uuid) || [];
    const memPercent = gpu.memTotalMB > 0 ? (gpu.memUsedMB / gpu.memTotalMB) * 100 : 0;
    lines.push(`GPU${gpu.index}  ${gpu.name}  ${gpu.utilPercent}% util  ${formatGiB(gpu.memUsedMB)}/${formatGiB(gpu.memTotalMB)}  ${gpu.tempC}C`);
    lines.push(`Util ${buildBar(gpu.utilPercent)} ${gpu.utilPercent}%`);
    lines.push(`Mem  ${buildBar(memPercent)} ${Math.round(memPercent)}%`);
    lines.push(`Pwr  ${buildBar(Math.min(100, gpu.powerW / 3.0))} ${gpu.powerW}W`);
    lines.push(`Spark ${buildSparkline(history)}`);
    if (gpu.processes.length === 0) {
      lines.push('  idle');
    } else {
      for (const proc of gpu.processes.slice(0, 4)) {
        lines.push(`  ${proc.pid} ${proc.name.slice(0, 24).padEnd(24, ' ')} ${formatGiB(proc.memoryMB)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export { queryGpuSnapshot, renderGpuSnapshot };
export type { GpuSnapshot, GpuInfo, GpuProc };
