// input:  raw stdout of the machines.detail shell probe
// output: buildProbeCommand + parseMachineProbe (pure) → { vitals, gpus }
// pos:    probe command text and its parser for the machines.detail handler
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { MachineGpu, MachineGpuProcess, MachineVitals } from '../types.js';

/** Probe budget: one bash round trip. Above the client's own spawn latency, below a stuck device. */
export const PROBE_TIMEOUT_MS = 15_000;

const KIB_PER_GIB = 1024 * 1024;

/** Single-quote a value for POSIX sh so registry-sourced paths cannot break out of the command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * One command, one round trip. Every stage is individually failure-tolerant (`2>/dev/null`) so a
 * host without nvidia-smi, /proc or `free` still returns the sections it can fill — the parser maps
 * the missing ones to null rather than to zero. `df -kP` forces POSIX single-line output.
 */
export function buildProbeCommand(cortexPath: string | null): string {
  const diskTarget = shellQuote(cortexPath && cortexPath.length > 0 ? cortexPath : '/');
  return [
    `echo '##GPU'`,
    'nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null',
    `echo '##PROC'`,
    'nvidia-smi --query-compute-apps=pid,process_name,used_memory,gpu_uuid --format=csv,noheader,nounits 2>/dev/null',
    `echo '##SYS'`,
    'echo "cores=$(nproc 2>/dev/null)"',
    `echo "load1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"`,
    `free -m 2>/dev/null | awk '/^Mem:/{printf "memTotalMb=%s\\nmemUsedMb=%s\\n", $2, $3}'`,
    `df -kP ${diskTarget} 2>/dev/null | awk 'NR==2{printf "diskTotalKb=%s\\ndiskFreeKb=%s\\n", $2, $4}'`,
    `echo "uptimeSec=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"`,
  ].join('\n');
}

/** Parse a numeric field; empty, absent and non-numeric all collapse to null (never 0). */
function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseGpuLine(line: string): { uuid: string; gpu: MachineGpu } | null {
  const parts = line.split(',').map((part) => part.trim());
  if (parts.length < 8) return null;
  const index = num(parts[0]);
  if (index === null) return null;
  return {
    uuid: parts[1],
    gpu: {
      index,
      name: parts[2],
      utilPercent: num(parts[3]) ?? 0,
      memUsedMb: num(parts[4]) ?? 0,
      memTotalMb: num(parts[5]) ?? 0,
      tempC: num(parts[6]) ?? 0,
      powerW: Math.round(num(parts[7]) ?? 0),
      processes: [],
    },
  };
}

/**
 * Windows hosts list every desktop app here with used_memory `[N/A]` — those are graphics clients,
 * not compute processes, and hold no memory we can attribute. Unparseable memory ⇒ drop the row.
 */
function parseProcLine(line: string): { uuid: string; proc: MachineGpuProcess } | null {
  const parts = line.split(',').map((part) => part.trim());
  if (parts.length < 4) return null;
  const memoryMb = num(parts[2]);
  if (memoryMb === null) return null;
  return { uuid: parts[3], proc: { pid: parts[0], name: parts[1], memoryMb } };
}

function toVitals(sys: Map<string, string>): MachineVitals {
  const diskTotalKb = num(sys.get('diskTotalKb'));
  const diskFreeKb = num(sys.get('diskFreeKb'));
  const uptimeSec = num(sys.get('uptimeSec'));
  return {
    cpuCores: num(sys.get('cores')),
    loadAvg1: num(sys.get('load1')),
    memUsedMb: num(sys.get('memUsedMb')),
    memTotalMb: num(sys.get('memTotalMb')),
    diskFreeGb: diskFreeKb === null ? null : diskFreeKb / KIB_PER_GIB,
    diskTotalGb: diskTotalKb === null ? null : diskTotalKb / KIB_PER_GIB,
    uptimeSec: uptimeSec === null ? null : Math.floor(uptimeSec),
  };
}

type Section = 'GPU' | 'PROC' | 'SYS' | null;

const SECTION_MARKERS: Record<string, Section> = {
  '##GPU': 'GPU',
  '##PROC': 'PROC',
  '##SYS': 'SYS',
};

/**
 * Split the probe stdout on its `##SECTION` markers, then join compute processes onto their GPU by
 * uuid. The uuid is a join key only — it stays out of the DTO. Malformed lines are dropped silently
 * because a partially-degraded host is the normal case, not an error worth failing the whole probe.
 */
export function parseMachineProbe(raw: string): { vitals: MachineVitals; gpus: MachineGpu[] } {
  const gpuByUuid = new Map<string, MachineGpu>();
  const gpus: MachineGpu[] = [];
  const procs: Array<{ uuid: string; proc: MachineGpuProcess }> = [];
  const sys = new Map<string, string>();
  let section: Section = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const marker = SECTION_MARKERS[trimmed];
    if (marker) {
      section = marker;
      continue;
    }
    if (section === 'GPU') {
      const parsed = parseGpuLine(trimmed);
      if (parsed) {
        gpuByUuid.set(parsed.uuid, parsed.gpu);
        gpus.push(parsed.gpu);
      }
    } else if (section === 'PROC') {
      const parsed = parseProcLine(trimmed);
      if (parsed) procs.push(parsed);
    } else if (section === 'SYS') {
      const eq = trimmed.indexOf('=');
      if (eq > 0) sys.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }

  for (const { uuid, proc } of procs) gpuByUuid.get(uuid)?.processes.push(proc);

  return { vitals: toVitals(sys), gpus };
}
