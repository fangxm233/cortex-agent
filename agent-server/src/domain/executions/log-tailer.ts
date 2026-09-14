// input:  a resolved LogLocation (local fs path or remote device+path) per running executionId
// output: { ExecutionLogTailer, executionLogTailer, resolveExecutionLogLocation, LogLocation, LogReader }
//         — ref-counted live tail of a running cortex-run/dispatch output.log, publishing bounded
//         `execution.log` EventBus events { executionId, seq, lines, dropped? }.
// pos:    domain/executions layer (L3). The genuinely-new engine for B2 live log streaming.
//         RED LINE: uses only the existing single-shot client actions (fs locally, `bash` remotely) —
//         no client WS protocol change, no client redeploy.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EventBus } from '@events/index.js';
import { createLogger } from '@core/log.js';
import { DATA_DIR } from '@core/paths.js';
import { getExecution as registryGetExecution } from '@domain/executions/registry.js';
import { getLocalMachine } from '@domain/tasks/dispatch-utils.js';
import { sendCommand } from '@domain/remote/client-manager.js';
import type { ExecutionRecord } from '@store/execution-repo.js';

const log = createLogger('execution-log-tailer');

/** Where a running execution's output.log lives — a local fs path or a remote device+path. */
export type LogLocation =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; device: string; path: string };

/** Reads the bytes appended since `offset`, returning the decoded chunk and the new offset. */
export type LogReader = (loc: LogLocation, offset: number) => Promise<{ chunk: string; nextOffset: number }>;

export interface ExecutionLogTailerOptions {
  /** Injectable reader (tests / custom transports). Defaults to fs-local + bash-remote. */
  read?: LogReader;
  /** Poll cadence; <= 0 disables the internal timer (tests drive pollOnce manually). */
  pollIntervalMs?: number;
  /** Max lines held between flushes; older lines are dropped (marked) when exceeded. */
  maxBufferLines?: number;
  /** Max bytes held between flushes; older lines are dropped (marked) when exceeded. */
  maxBufferBytes?: number;
  /** Max bytes read from the source per poll (throttles a huge backlog into successive events). */
  maxReadBytes?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_BUFFER_LINES = 1000;
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;
const DEFAULT_MAX_READ_BYTES = 64 * 1024;

interface TailState {
  location: LogLocation;
  refCount: number;
  offset: number;
  carry: string;
  buffer: string[];
  dropped: number;
  seq: number;
  timer: ReturnType<typeof setInterval> | null;
  reading: boolean;
}

// --- Default readers (single-shot client actions only) ---

function defaultLocalRead(p: string, offset: number, maxReadBytes: number): { chunk: string; nextOffset: number } {
  let size: number;
  try { size = fs.statSync(p).size; } catch { return { chunk: '', nextOffset: offset }; }
  const start = size < offset ? 0 : offset; // shrink ⇒ rotated/truncated, restart from head
  if (size <= start) return { chunk: '', nextOffset: size };
  const len = Math.min(size - start, maxReadBytes);
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, start);
    return { chunk: buf.subarray(0, bytesRead).toString('utf8'), nextOffset: start + bytesRead };
  } finally {
    fs.closeSync(fd);
  }
}

async function defaultRemoteRead(device: string, p: string, offset: number, maxReadBytes: number): Promise<{ chunk: string; nextOffset: number }> {
  const quoted = `'${p.replace(/'/g, `'\\''`)}'`;
  const cmd = `tail -c +${offset + 1} -- ${quoted} 2>/dev/null | head -c ${maxReadBytes}`;
  const res = await sendCommand(device, { action: 'bash', params: { command: cmd }, timeout: 30_000 });
  const chunk = res && typeof res.stdout === 'string' ? res.stdout : '';
  return { chunk, nextOffset: offset + Buffer.byteLength(chunk, 'utf8') };
}

function makeDefaultReader(maxReadBytes: number): LogReader {
  return (loc, offset) =>
    loc.kind === 'local'
      ? Promise.resolve(defaultLocalRead(loc.path, offset, maxReadBytes))
      : defaultRemoteRead(loc.device, loc.path, offset, maxReadBytes);
}

/**
 * Registry-only resolution of a running execution's log location (B2-C). The cortex-run run name
 * is persisted on `dispatch.runName` at launch, so the executionId alone is sufficient: the run's
 * output.log is `<tmpBaseDir>/<runName>/output.log`, and local-vs-remote is decided by
 * `dispatch.machine`. Returns null for an unknown id or one with no runName (nothing to tail).
 */
export function resolveExecutionLogLocation(
  executionId: string,
  opts: {
    getExecution?: (id: string) => Pick<ExecutionRecord, 'dispatch'> | null;
    localMachine?: string;
    tmpBaseDir?: string;
  } = {},
): LogLocation | null {
  const get = opts.getExecution ?? registryGetExecution;
  const rec = get(executionId);
  const runName = rec?.dispatch?.runName ?? null;
  if (!runName) return null;
  const base = opts.tmpBaseDir ?? path.join(DATA_DIR, 'tmp', 'cortex-run');
  const logPath = path.join(base, runName, 'output.log');
  const machine = rec.dispatch?.machine ?? null;
  const local = opts.localMachine ?? getLocalMachine();
  if (!machine || machine === 'local' || machine === local) {
    return { kind: 'local', path: logPath };
  }
  return { kind: 'remote', device: machine, path: logPath };
}

export class ExecutionLogTailer {
  private states = new Map<string, TailState>();
  private bus: EventBus | null = null;
  private readonly read: LogReader;
  private readonly pollIntervalMs: number;
  private readonly maxBufferLines: number;
  private readonly maxBufferBytes: number;

  constructor(opts: ExecutionLogTailerOptions = {}) {
    this.read = opts.read ?? makeDefaultReader(opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxBufferLines = opts.maxBufferLines ?? DEFAULT_MAX_BUFFER_LINES;
    this.maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  setBus(bus: EventBus): void {
    this.bus = bus;
  }

  /** Current subscriber ref-count for an execution (0 if not tailing). */
  refCount(executionId: string): number {
    return this.states.get(executionId)?.refCount ?? 0;
  }

  /**
   * Register interest in an execution's live log. Ref-counted: the first call opens the tail
   * (and starts the poll timer); subsequent calls only bump the count. `location` is supplied by
   * the caller (resolveExecutionLogLocation is the registry-backed helper).
   */
  startTail(executionId: string, location: LogLocation): void {
    const existing = this.states.get(executionId);
    if (existing) { existing.refCount++; return; }

    const state: TailState = {
      location, refCount: 1, offset: 0, carry: '', buffer: [], dropped: 0, seq: 0, timer: null, reading: false,
    };
    this.states.set(executionId, state);

    if (this.pollIntervalMs > 0) {
      state.timer = setInterval(() => { void this.pollOnce(executionId); }, this.pollIntervalMs);
      state.timer.unref?.();
    }
  }

  /** Release interest. The last release tears down the underlying tail (timer + offset state). */
  stopTail(executionId: string): void {
    const state = this.states.get(executionId);
    if (!state) return;
    state.refCount--;
    if (state.refCount > 0) return;
    if (state.timer) clearInterval(state.timer);
    this.states.delete(executionId);
  }

  /**
   * Read and publish one increment. Public so the poll timer and tests share one path.
   * No-op when the execution is not tailing, no bus is wired, or a read is already in flight.
   */
  async pollOnce(executionId: string): Promise<void> {
    const state = this.states.get(executionId);
    if (!state || !this.bus || state.reading) return;
    state.reading = true;
    try {
      const { chunk, nextOffset } = await this.read(state.location, state.offset);
      if (!this.states.has(executionId)) return; // torn down while awaiting
      state.offset = nextOffset;
      if (!chunk) return;
      this.ingest(state, chunk);
      this.flush(executionId, state);
    } catch (err) {
      log.warn(`tail read failed for ${executionId}: ${(err as Error).message}`);
    } finally {
      state.reading = false;
    }
  }

  /** Split a chunk into complete lines, holding a trailing partial line for the next read. */
  private ingest(state: TailState, chunk: string): void {
    const parts = (state.carry + chunk).split('\n');
    state.carry = parts.pop() ?? '';
    for (const line of parts) state.buffer.push(line);
    this.enforceBound(state);
  }

  /** Drop-oldest until within the line AND byte caps, accumulating the drop count. */
  private enforceBound(state: TailState): void {
    if (state.buffer.length > this.maxBufferLines) {
      const drop = state.buffer.length - this.maxBufferLines;
      state.buffer.splice(0, drop);
      state.dropped += drop;
    }
    let bytes = 0;
    for (const l of state.buffer) bytes += Buffer.byteLength(l, 'utf8');
    while (state.buffer.length > 0 && bytes > this.maxBufferBytes) {
      bytes -= Buffer.byteLength(state.buffer.shift()!, 'utf8');
      state.dropped += 1;
    }
  }

  private flush(executionId: string, state: TailState): void {
    if (state.buffer.length === 0) return;
    const lines = state.buffer;
    const dropped = state.dropped;
    state.buffer = [];
    state.dropped = 0;
    this.bus!.publish({
      type: 'execution.log',
      executionId,
      seq: state.seq++,
      lines,
      ...(dropped > 0 ? { dropped } : {}),
    });
  }
}

/** Process-wide singleton, wired to the EventBus in entry/app.ts. */
export const executionLogTailer = new ExecutionLogTailer();
