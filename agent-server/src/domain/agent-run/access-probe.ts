// input:  pinned launch, strace, supervisor, and C8 roots
// output: verdict, named failures, and human summary
// pos:    Contains and classifies syscall probe executions
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  classifyTraceStream,
  type AccessProbeCounts,
  type AccessProbePolicy,
  type AccessViolation,
} from './access-probe-policy.js';
import {
  preparePinnedNodeLaunch,
  type PinnedNodeLaunchOptions,
} from './pinned-node-process.js';
import { attachSupervisor, resolveSupervisorBinary } from './supervisor.js';

export type ProbeFailureReason =
  | 'strace_unavailable'
  | 'ptrace_unavailable'
  | 'trace_missing'
  | 'target_failed'
  | 'probe_timeout'
  | 'containment_failed';

export interface NodeAccessProbeOptions extends Omit<PinnedNodeLaunchOptions, 'stdio'> {
  installRoot: string;
  hostHome: string;
  hostCortexHome: string;
  stracePath?: string;
  timeoutMs?: number;
  supervisorBinary?: string;
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
  timedOut: boolean;
  containmentFailed: boolean;
}

interface TraceEvidence {
  directory: string;
  fd: number;
  outputArg: string;
  retainedPath: string;
}

function emptyCounts(): AccessProbeCounts {
  return { traceLines: 0, fileCalls: 0, networkCalls: 0, allowed: 0 };
}

const MAX_STDERR_BYTES = 64 * 1024;

function appendText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', (chunk: Buffer) => {
      if (text.length >= MAX_STDERR_BYTES) return;
      text += chunk.subarray(0, MAX_STDERR_BYTES - text.length).toString();
    });
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

function straceArguments(traceOutput: string, launch: ReturnType<typeof preparePinnedNodeLaunch>) {
  return [
    '-f', '-qq', '-ttt', '-yy', '-s', '4096',
    '-e', 'trace=%file,%network,%process',
    '-o', traceOutput,
    '--', launch.command, ...launch.args,
  ];
}

async function executeTrace(
  supervisorBinary: string, binary: string, traceOutput: string,
  launch: ReturnType<typeof preparePinnedNodeLaunch>, timeoutMs: number,
): Promise<TraceExecution> {
  const session = attachSupervisor({
    binary: supervisorBinary,
    args: [binary, ...straceArguments(traceOutput, launch)],
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    deadlineMs: timeoutMs,
    graceMs: 0,
  });
  session.process.stdout?.resume();
  const stderr = appendText(session.process.stderr);
  let deadlineElapsed = false;
  const timer = setTimeout(() => { deadlineElapsed = true; }, timeoutMs);
  const results = await Promise.allSettled([session.exited, session.quiescent, session.closed]);
  clearTimeout(timer);
  await session.dispose();
  const exited = results[0].status === 'fulfilled' ? results[0].value : null;
  const closed = results[2].status === 'fulfilled' ? results[2].value : null;
  return {
    code: exited?.code ?? null,
    signal: (exited?.signal ?? null) as NodeJS.Signals | null,
    stderr: await stderr,
    timedOut: deadlineElapsed && closed?.code === 124,
    containmentFailed: results.some(result => result.status === 'rejected'),
  };
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = command.includes(path.sep)
    ? [command]
    : (env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); }
    catch {}
  }
  return null;
}

function createTraceEvidence(logsDir: string): TraceEvidence {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-access-trace-'));
  const source = path.join(directory, 'evidence');
  const fd = fs.openSync(source, 'w+', 0o600);
  fs.unlinkSync(source);
  return {
    directory,
    fd,
    outputArg: `/proc/${process.pid}/fd/${fd}`,
    retainedPath: path.join(logsDir, `access.trace.${randomUUID()}`),
  };
}

function closeTraceEvidence(evidence: TraceEvidence): void {
  try { fs.closeSync(evidence.fd); }
  finally { fs.rmdirSync(evidence.directory); }
}

function evidenceStream(evidence: TraceEvidence): fs.ReadStream {
  return fs.createReadStream(`/proc/${process.pid}/fd/${evidence.fd}`, { start: 0 });
}

async function retainEvidence(evidence: TraceEvidence): Promise<void> {
  await pipeline(evidenceStream(evidence), fs.createWriteStream(evidence.retainedPath, {
    flags: 'wx', mode: 0o600,
  }));
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
    tracedPids: new Set<number>(),
    nodeModuleRoots: existingRealpaths([
      path.join(installRoot, 'node_modules'),
      path.join(path.dirname(installRoot), 'node_modules'),
    ]),
  };
}

async function classifyEvidence(
  evidence: TraceEvidence, policy: AccessProbePolicy, initialCwd: string,
): Promise<{ counts: AccessProbeCounts; violations: AccessViolation[] }> {
  return classifyTraceStream(evidenceStream(evidence), {
    policy, initialCwd, pid: 0, traceFile: evidence.retainedPath,
  });
}

function failureReason(execution: TraceExecution, hasTrace: boolean): ProbeFailureReason | undefined {
  if (/ptrace.*(?:not permitted|operation not permitted|permission denied)/i.test(execution.stderr)) {
    return 'ptrace_unavailable';
  }
  if (execution.timedOut) return 'probe_timeout';
  if (execution.containmentFailed) return 'containment_failed';
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
  const binary = resolveExecutable(options.stracePath ?? 'strace', launch.env);
  if (!binary) return unavailableVerdict('strace_unavailable');
  const supervisor = resolveSupervisorBinary(options.supervisorBinary);
  const evidence = createTraceEvidence(launch.paths.logsDir);
  try {
    const execution = await executeTrace(
      supervisor, binary, evidence.outputArg, launch, options.timeoutMs ?? 30_000,
    );
    const hasTrace = fs.fstatSync(evidence.fd).size > 0;
    const reason = failureReason(execution, hasTrace);
    if (!hasTrace) return unavailableVerdict(reason ?? 'trace_missing');
    const classified = await classifyEvidence(evidence, buildPolicy(options, launch), launch.cwd);
    await retainEvidence(evidence);
    return {
      ok: reason === undefined && classified.violations.length === 0,
      violations: classified.violations,
      counts: classified.counts,
      failureReason: reason,
      targetExitCode: execution.code,
      traceFiles: [evidence.retainedPath],
    };
  } finally {
    closeTraceEvidence(evidence);
  }
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
