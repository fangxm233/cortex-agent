// input:  supervisor executable, control-fd records, shutdown signals
// output: strict protocol parser, supervised session, exit taxonomy
// pos:    Process-supervisor client for one-shot agent runs
// >>> If I am updated, update my header and folder CORTEX.md <<<

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { Readable } from 'node:stream';

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type SupervisorLine =
  | { v: 1; type: 'started'; pid: number; pgid: number; ts: string }
  | { v: 1; type: 'exited'; code: number | null; signal: string | null; ts: string }
  | { v: 1; type: 'quiescent'; descendants: 0; ts: string }
  | { v: 1; type: 'error'; reason: 'unsupported_platform' | 'containment_failed'; ts: string };

export type ExitReason =
  | 'ok'
  | 'child_failure'
  | 'deadline'
  | 'cancelled'
  | 'containment_failure'
  | 'trajectory_write_failed';

const EXIT_CODES = {
  ok: 0,
  deadline: 124,
  cancelled: 130,
  containment_failure: 125,
  trajectory_write_failed: 74,
} satisfies Record<Exclude<ExitReason, 'child_failure'>, number>;

export type SupervisorContainmentDetail =
  | 'unsupported_platform'
  | 'containment_failed'
  | 'missing_quiescent'
  | 'spawn_failed'
  | 'signal_failed';

export class SupervisorProtocolError extends Error {
  readonly reason = 'protocol_violation' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SupervisorProtocolError';
  }
}

export class SupervisorContainmentError extends Error {
  readonly reason = 'containment_failure' as const;

  constructor(readonly detail: SupervisorContainmentDetail, options?: { cause?: unknown }) {
    super(`Supervisor containment failed: ${detail}`, options);
    this.name = 'SupervisorContainmentError';
  }
}

export interface SupervisorSession {
  started: Promise<{ pid: number; pgid: number }>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  quiescent: Promise<void>;
  cancel(reason: 'cancel' | 'deadline'): void;
  dispose(): Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
}

interface SessionDeferreds {
  started: Deferred<{ pid: number; pgid: number }>;
  exited: Deferred<{ code: number | null; signal: string | null }>;
  quiescent: Deferred<void>;
}

type ProtocolPhase = 'await_started' | 'await_exited' | 'await_quiescent' | 'quiescent' | 'failed';
type StdioMode = 'inherit' | 'ignore' | 'pipe';

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (value) => {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };
  void deferred.promise.catch(() => {});
  return deferred;
}

function protocolError(message: string, cause?: unknown): SupervisorProtocolError {
  return new SupervisorProtocolError(message, cause === undefined ? undefined : { cause });
}

function parseJsonObject(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw protocolError('Malformed supervisor JSON record', error);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError('Supervisor record must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function requireShape(record: Record<string, unknown>, keys: string[], type: string): void {
  if (!hasExactKeys(record, keys)) throw protocolError(`Invalid ${type} supervisor record fields`);
}

function requireTimestamp(value: unknown): asserts value is string {
  const date = typeof value === 'string' ? new Date(value) : null;
  const valid = date !== null && TIMESTAMP_PATTERN.test(value as string)
    && Number.isFinite(date.getTime()) && date.toISOString() === value;
  if (!valid) throw protocolError('Invalid supervisor record timestamp');
}

function parseStarted(record: Record<string, unknown>): SupervisorLine {
  requireShape(record, ['v', 'type', 'pid', 'pgid', 'ts'], 'started');
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || !Number.isSafeInteger(record.pgid) || Number(record.pgid) <= 0) {
    throw protocolError('Invalid started supervisor record');
  }
  requireTimestamp(record.ts);
  return record as SupervisorLine;
}

function parseExited(record: Record<string, unknown>): SupervisorLine {
  requireShape(record, ['v', 'type', 'code', 'signal', 'ts'], 'exited');
  const validCode = record.code === null || Number.isSafeInteger(record.code);
  const validSignal = record.signal === null || typeof record.signal === 'string';
  if (!validCode || !validSignal) throw protocolError('Invalid exited supervisor record');
  requireTimestamp(record.ts);
  return record as SupervisorLine;
}

function parseQuiescent(record: Record<string, unknown>): SupervisorLine {
  requireShape(record, ['v', 'type', 'descendants', 'ts'], 'quiescent');
  if (record.descendants !== 0) throw protocolError('Invalid quiescent supervisor record');
  requireTimestamp(record.ts);
  return record as SupervisorLine;
}

function parseError(record: Record<string, unknown>): SupervisorLine {
  requireShape(record, ['v', 'type', 'reason', 'ts'], 'error');
  if (record.reason !== 'unsupported_platform' && record.reason !== 'containment_failed') {
    throw protocolError('Invalid error supervisor record');
  }
  requireTimestamp(record.ts);
  return record as SupervisorLine;
}

export function parseSupervisorLine(line: string): SupervisorLine {
  const record = parseJsonObject(line);
  if (record.v !== 1) throw protocolError('Missing or unsupported supervisor protocol version');
  if (record.type === 'started') return parseStarted(record);
  if (record.type === 'exited') return parseExited(record);
  if (record.type === 'quiescent') return parseQuiescent(record);
  if (record.type === 'error') return parseError(record);
  throw protocolError('Unknown supervisor record type');
}

export function exitCodeFor(reason: ExitReason, childCode?: number): number {
  if (reason === 'child_failure') return Number.isInteger(childCode) && childCode !== 0 ? childCode : 1;
  return EXIT_CODES[reason];
}

class ProtocolState {
  private phase: ProtocolPhase = 'await_started';

  constructor(
    private readonly deferreds: SessionDeferreds,
    private readonly terminate: () => void,
  ) {}

  get terminal(): boolean {
    return this.phase === 'quiescent' || this.phase === 'failed';
  }

  accept(record: SupervisorLine): void {
    if (record.type === 'error') return this.fail(new SupervisorContainmentError(record.reason));
    if (record.type === 'started') return this.acceptStarted(record);
    if (record.type === 'exited') return this.acceptExited(record);
    this.acceptQuiescent();
  }

  fail(error: Error, terminate = true): void {
    if (this.terminal) return;
    this.phase = 'failed';
    this.deferreds.started.reject(error);
    this.deferreds.exited.reject(error);
    this.deferreds.quiescent.reject(error);
    if (terminate) this.terminate();
  }

  controlClosed(): void {
    if (this.terminal) return;
    this.fail(new SupervisorContainmentError('missing_quiescent'), false);
  }

  private acceptStarted(record: Extract<SupervisorLine, { type: 'started' }>): void {
    if (this.phase !== 'await_started') return this.fail(protocolError('Unexpected started record'));
    this.phase = 'await_exited';
    this.deferreds.started.resolve({ pid: record.pid, pgid: record.pgid });
  }

  private acceptExited(record: Extract<SupervisorLine, { type: 'exited' }>): void {
    if (this.phase !== 'await_exited') return this.fail(protocolError('Unexpected exited record'));
    this.phase = 'await_quiescent';
    this.deferreds.exited.resolve({ code: record.code, signal: record.signal });
  }

  private acceptQuiescent(): void {
    if (this.phase !== 'await_quiescent') return this.fail(protocolError('Unexpected quiescent record'));
    this.phase = 'quiescent';
    this.deferreds.quiescent.resolve();
  }
}

function validateControlFd(controlFd: number): void {
  if (!Number.isSafeInteger(controlFd) || controlFd <= 2) {
    throw new RangeError('controlFd must be an integer greater than 2');
  }
}

function validateMilliseconds(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function buildSupervisorArgs(options: {
  args: string[];
  controlFd: number;
  graceMs?: number;
  deadlineMs?: number;
}): string[] {
  const result = ['--control-fd', String(options.controlFd)];
  if (options.graceMs !== undefined) result.push('--grace-ms', String(options.graceMs));
  if (options.deadlineMs !== undefined) result.push('--deadline-ms', String(options.deadlineMs));
  return [...result, '--', ...options.args];
}

function buildStdio(controlFd: number): StdioMode[] {
  const stdio: StdioMode[] = ['inherit', 'inherit', 'inherit'];
  while (stdio.length <= controlFd) stdio.push('ignore');
  stdio[controlFd] = 'pipe';
  return stdio;
}

function createDeferreds(): SessionDeferreds {
  return {
    started: createDeferred(),
    exited: createDeferred(),
    quiescent: createDeferred(),
  };
}

function stopProcess(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    return child.kill('SIGTERM');
  } catch {
    return false;
  }
}

function handleLine(state: ProtocolState, line: string): void {
  try {
    state.accept(parseSupervisorLine(line));
  } catch (error) {
    state.fail(error instanceof Error ? error : protocolError('Supervisor protocol failure', error));
  }
}

function removeSessionListeners(child: ChildProcess, control: Readable, lines: Interface): void {
  child.removeAllListeners('error');
  child.removeAllListeners('close');
  control.removeAllListeners('error');
  lines.removeAllListeners('line');
  lines.removeAllListeners('close');
}

class AttachedSupervisorSession implements SupervisorSession {
  private readonly deferreds = createDeferreds();
  private readonly processClosed = createDeferred<void>();
  private readonly controlClosed = createDeferred<void>();
  private readonly state: ProtocolState;
  private shutdownReason: 'cancel' | 'deadline' | null = null;
  private disposePromise: Promise<void> | null = null;
  readonly started = this.deferreds.started.promise;
  readonly exited = this.deferreds.exited.promise;
  readonly quiescent = this.deferreds.quiescent.promise;

  constructor(
    private readonly child: ChildProcess,
    private readonly control: Readable,
    private readonly lines: Interface,
  ) {
    this.state = new ProtocolState(this.deferreds, () => { stopProcess(this.child); });
    this.wireListeners();
  }

  cancel(reason: 'cancel' | 'deadline'): void {
    if (this.shutdownReason !== null || this.state.terminal) return;
    this.shutdownReason = reason;
    if (!stopProcess(this.child)) {
      this.state.fail(new SupervisorContainmentError('signal_failed'), false);
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.finishDisposal();
    return this.disposePromise;
  }

  private wireListeners(): void {
    this.lines.on('line', line => handleLine(this.state, line));
    this.lines.once('close', () => this.onControlClose());
    this.control.once('error', error => {
      this.state.fail(protocolError('Supervisor control fd failed', error));
    });
    this.child.once('error', error => this.onChildError(error));
    this.child.once('close', () => this.processClosed.resolve());
  }

  private onControlClose(): void {
    this.state.controlClosed();
    this.controlClosed.resolve();
  }

  private onChildError(error: Error): void {
    this.state.fail(new SupervisorContainmentError('spawn_failed', { cause: error }), false);
    this.processClosed.resolve();
  }

  private async finishDisposal(): Promise<void> {
    if (!this.state.terminal) this.cancel('cancel');
    await Promise.allSettled([
      this.deferreds.quiescent.promise,
      this.processClosed.promise,
      this.controlClosed.promise,
    ]);
    this.lines.close();
    removeSessionListeners(this.child, this.control, this.lines);
  }
}

function validateAttachOptions(options: {
  graceMs?: number;
  deadlineMs?: number;
  controlFd?: number;
}): number {
  const controlFd = options.controlFd ?? 3;
  validateControlFd(controlFd);
  validateMilliseconds('graceMs', options.graceMs);
  validateMilliseconds('deadlineMs', options.deadlineMs);
  return controlFd;
}

export function attachSupervisor(options: {
  binary: string;
  args: string[];
  graceMs?: number;
  deadlineMs?: number;
  controlFd?: number;
}): SupervisorSession {
  const controlFd = validateAttachOptions(options);
  const child = spawn(options.binary, buildSupervisorArgs({ ...options, controlFd }), {
    stdio: buildStdio(controlFd),
  });
  const control = child.stdio[controlFd] as Readable;
  const lines = createInterface({ input: control, crlfDelay: Infinity });
  return new AttachedSupervisorSession(child, control, lines);
}
