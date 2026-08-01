// input:  pinned Node launch options, strace, and C8 policy roots
// output: machine verdict, named probe failures, and human summary
// pos:    Executes and classifies file/network syscall probes
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyTraceLines,
  type AccessProbeCounts,
  type AccessProbePolicy,
  type AccessViolation,
} from './access-probe-policy.js';
import {
  preparePinnedNodeLaunch,
  type PinnedNodeLaunchOptions,
} from './pinned-node-process.js';

export type ProbeFailureReason =
  | 'strace_unavailable'
  | 'ptrace_unavailable'
  | 'trace_missing'
  | 'target_failed'
  | 'probe_timeout';

export interface NodeAccessProbeOptions extends Omit<PinnedNodeLaunchOptions, 'stdio'> {
  installRoot: string;
  hostHome: string;
  hostCortexHome: string;
  stracePath?: string;
  timeoutMs?: number;
}

export interface AccessProbeVerdict {
  ok: boolean;
  violations: AccessViolation[];
  counts: AccessProbeCounts;
  failureReason?: ProbeFailureReason;
  targetExitCode?: number | null;
  traceFiles: string[];
}

interface TraceExecution {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
  timedOut: boolean;
}

function emptyCounts(): AccessProbeCounts {
  return { traceLines: 0, fileCalls: 0, networkCalls: 0, allowed: 0 };
}

function appendText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', chunk => { text += chunk.toString(); });
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

function stopProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function waitForTraceProcess(child: ChildProcess, timeoutMs: number): Promise<TraceExecution> {
  const stderr = appendText(child.stderr);
  let spawnError: NodeJS.ErrnoException | undefined;
  child.once('error', error => { spawnError = error; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopProcessGroup(child);
  }, timeoutMs);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  return { ...result, stderr: await stderr, spawnError, timedOut };
}

function straceArguments(tracePrefix: string, launch: ReturnType<typeof preparePinnedNodeLaunch>) {
  return [
    '-f', '-ff', '-qq', '-ttt', '-yy', '-s', '4096',
    '-e', 'trace=%file,%network,%process',
    '-o', tracePrefix,
    '--', launch.command, ...launch.args,
  ];
}

async function executeTrace(
  binary: string, tracePrefix: string, launch: ReturnType<typeof preparePinnedNodeLaunch>,
  timeoutMs: number,
): Promise<TraceExecution> {
  const child = spawn(binary, straceArguments(tracePrefix, launch), {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    shell: false,
  });
  child.stdout?.resume();
  return waitForTraceProcess(child, timeoutMs);
}

function traceFiles(tracePrefix: string): string[] {
  const directory = path.dirname(tracePrefix);
  const prefix = `${path.basename(tracePrefix)}.`;
  return fs.readdirSync(directory)
    .filter(name => name.startsWith(prefix))
    .map(name => path.join(directory, name))
    .sort();
}

function existingRealpaths(values: string[]): string[] {
  return values.flatMap((value) => {
    try {
      return [fs.realpathSync(value)];
    } catch {
      return [];
    }
  });
}

function buildPolicy(
  options: NodeAccessProbeOptions,
  launch: ReturnType<typeof preparePinnedNodeLaunch>,
): AccessProbePolicy {
  const installRoot = fs.realpathSync(options.installRoot);
  return {
    workspace: launch.cwd,
    cortexHome: launch.paths.cortexHome,
    logsDir: launch.paths.logsDir,
    installRoot,
    hostHome: path.resolve(options.hostHome),
    hostCortexHome: path.resolve(options.hostCortexHome),
    nodeExecutable: launch.command,
    nodeModuleRoots: existingRealpaths([
      path.join(installRoot, 'node_modules'),
      path.join(path.dirname(installRoot), 'node_modules'),
    ]),
  };
}

function mergeCounts(target: AccessProbeCounts, addition: AccessProbeCounts): void {
  target.traceLines += addition.traceLines;
  target.fileCalls += addition.fileCalls;
  target.networkCalls += addition.networkCalls;
  target.allowed += addition.allowed;
}

function classifyFiles(
  files: string[], policy: AccessProbePolicy, initialCwd: string,
): { counts: AccessProbeCounts; violations: AccessViolation[] } {
  const counts = emptyCounts();
  const violations: AccessViolation[] = [];
  for (const file of files) {
    const pid = Number(path.extname(file).slice(1));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const result = classifyTraceLines(lines, { policy, initialCwd, pid, traceFile: file });
    mergeCounts(counts, result.counts);
    violations.push(...result.violations);
  }
  return { counts, violations };
}

function failureReason(execution: TraceExecution, hasTrace: boolean): ProbeFailureReason | undefined {
  if (execution.spawnError?.code === 'ENOENT') return 'strace_unavailable';
  if (/ptrace.*(?:not permitted|operation not permitted|permission denied)/i.test(execution.stderr)) {
    return 'ptrace_unavailable';
  }
  if (execution.timedOut) return 'probe_timeout';
  if (!hasTrace) return 'trace_missing';
  if (execution.code !== 0 || execution.signal !== null) return 'target_failed';
  return undefined;
}

function unavailableVerdict(reason: ProbeFailureReason): AccessProbeVerdict {
  return { ok: false, violations: [], counts: emptyCounts(), failureReason: reason, traceFiles: [] };
}

export async function runNodeAccessProbe(
  options: NodeAccessProbeOptions,
): Promise<AccessProbeVerdict> {
  const launch = preparePinnedNodeLaunch(options);
  const tracePrefix = path.join(launch.paths.logsDir, 'access.trace');
  const execution = await executeTrace(
    options.stracePath ?? 'strace', tracePrefix, launch, options.timeoutMs ?? 30_000,
  );
  const files = traceFiles(tracePrefix);
  const reason = failureReason(execution, files.length > 0);
  if (files.length === 0) return unavailableVerdict(reason ?? 'trace_missing');
  const classified = classifyFiles(files, buildPolicy(options, launch), launch.cwd);
  return {
    ok: reason === undefined && classified.violations.length === 0,
    violations: classified.violations,
    counts: classified.counts,
    failureReason: reason,
    targetExitCode: execution.code,
    traceFiles: files,
  };
}

function countSummary(verdict: AccessProbeVerdict): string {
  return `${verdict.counts.fileCalls} file accesses, ${verdict.counts.networkCalls} network calls`;
}

export function formatAccessProbeSummary(verdict: AccessProbeVerdict): string {
  if (verdict.ok) return `Access probe OK: ${countSummary(verdict)}, 0 violations.`;
  const reason = verdict.failureReason ? ` failure=${verdict.failureReason};` : '';
  const header = `Access probe DENIED:${reason} ${countSummary(verdict)}, ${verdict.violations.length} violations.`;
  const details = verdict.violations.map(item => (
    `- ${item.syscall} ${item.path} (${item.reason})`
  ));
  return [header, ...details].join('\n');
}
