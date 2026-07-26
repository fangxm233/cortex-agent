// input:  EventBus (event-bus.ts), CortexEvent (event-types.ts)
// output: createEventLogger — writes events to daily rolling jsonl files
// pos:    events/ layer, depends on event-bus + event-types + core/async-mutex
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncMutex } from '@core/async-mutex.js';
import { DATA_DIR } from '@core/paths.js';
import type { CortexEvent } from './event-types.js';
import type { EventBus } from './event-bus.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BUFFER_SIZE = 1024;
const FLUSH_INTERVAL_MS = 100;
const RETENTION_DAYS = 14;

/**
 * Meta-events emitted by the bus infrastructure itself.
 * The logger skips adding these to its own ring buffer to prevent re-entrant
 * backpressure loops (e.g., event-logger.dropped triggering another drop).
 * They are still published on the bus and visible to other subscribers.
 */
const META_EVENTS = new Set<string>([
  'event-bus.handler-failed',
  'event-logger.dropped',
]);

/**
 * Transient events that are deliberately NOT written to the log.
 *
 * `session.message.delta` is a token-level preview of a block the bus also carries complete: dozens
 * of them per reply, all of it repeated verbatim by the `session.message` that follows. Logging
 * them would multiply the daily jsonl for zero recoverable information, and would evict real events
 * from the ring buffer while doing it. They are still published — live subscribers get them.
 */
const TRANSIENT_EVENTS = new Set<string>([
  'session.message.delta',
]);

// ── Types ────────────────────────────────────────────────────────────────────

interface LogEntry {
  ts: string;
  type: string;
  payload: CortexEvent;
  pid: number;
  seq: number;
}

export interface EventLoggerOptions {
  /** Override for testing; production default is 1024. */
  bufferSize?: number;
  /** Override log directory; production default is <agent-server>/logs/events. */
  logDir?: string;
}

export interface EventLogger {
  /** Flush all buffered entries to disk. Called automatically by bus.close(). */
  close(): Promise<void>;
}

// ── Implementation ────────────────────────────────────────────────────────────

export function createEventLogger(bus: EventBus, opts?: EventLoggerOptions): EventLogger {
  const bufferSize = opts?.bufferSize ?? DEFAULT_BUFFER_SIZE;
  const disabled = process.env.CORTEX_EVENT_LOG === 'off';

  const logDir = opts?.logDir ?? path.join(DATA_DIR, 'logs', 'events');

  let buffer: LogEntry[] = [];
  let seq = 0;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  const flushMutex = new AsyncMutex();
  let _inDrop = false;
  let _lastCleanupDate = '';  // NTH-2: run retention cleanup at most once per day

  function todayYYYYMMDD(): string {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  function onEvent(e: CortexEvent): void {
    if (disabled) return;
    // Skip meta-events to prevent re-entrant backpressure loops (see META_EVENTS comment above)
    if (META_EVENTS.has(e.type)) return;
    // Skip high-volume previews that carry nothing the complete event doesn't (see TRANSIENT_EVENTS)
    if (TRANSIENT_EVENTS.has(e.type)) return;

    // Backpressure: drop oldest entry if ring buffer is full
    if (buffer.length >= bufferSize) {
      const dropped = buffer.shift()!;
      if (!_inDrop) {
        _inDrop = true;
        try {
          bus.publish({
            type: 'event-logger.dropped',
            droppedSeq: dropped.seq,
            droppedType: dropped.type,
          });
        } finally {
          _inDrop = false;
        }
      }
    }

    buffer.push({
      ts: e.ts,
      type: e.type,
      payload: e,
      pid: process.pid,
      seq: seq++,
    });

    // Trigger immediate flush when buffer hits capacity (spec: "buffer full, flush immediately")
    if (buffer.length >= bufferSize) {
      void flushNow();
    }
  }

  async function flushNow(): Promise<void> {
    if (disabled) return;
    // Snapshot buffer outside the mutex to minimise lock hold time
    if (buffer.length === 0) return;

    return flushMutex.run(async () => {
      if (buffer.length === 0) return;
      const entries = buffer.splice(0);

      // Note: we use flush-time date for file routing (NTH-4 acknowledged).
      // Each entry carries its own `ts` field so replay is always timestamp-correct.
      const dateStr = todayYYYYMMDD();
      const logFile = path.join(logDir, `events-${dateStr}.jsonl`);

      await fs.mkdir(logDir, { recursive: true });
      await fs.appendFile(logFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

      // Retention: delete files older than RETENTION_DAYS — at most once per calendar day (NTH-2)
      if (dateStr !== _lastCleanupDate) {
        _lastCleanupDate = dateStr;
        void runRetentionCleanup();
      }
    });
  }

  async function runRetentionCleanup(): Promise<void> {
    try {
      const entries = await fs.readdir(logDir);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
      const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, '');

      await Promise.all(
        entries
          .filter((f) => /^events-\d{8}\.jsonl$/.test(f))
          .filter((f) => {
            const dateInFile = f.slice(7, 15); // extract YYYYMMDD from "events-YYYYMMDD.jsonl"
            return dateInFile < cutoffStr;
          })
          .map((f) => fs.unlink(path.join(logDir, f)).catch(() => {})),
      );
    } catch {
      // Best-effort; missing directory is fine on first run
    }
  }

  /**
   * Flush remaining buffer entries and stop the interval timer.
   * Registered as a close hook on the bus; called from bus.close() on SIGTERM.
   * NTH-3: explicit clearInterval + return flushNow() pattern.
   */
  async function close(): Promise<void> {
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    return flushNow();
  }

  // ── Wire up ────────────────────────────────────────────────────────────────

  if (!disabled) {
    bus.subscribe('*', onEvent);
    flushTimer = setInterval(() => { void flushNow(); }, FLUSH_INTERVAL_MS);
    // Prevent the timer from keeping the process alive after bus.close()
    if (flushTimer.unref) flushTimer.unref();
  }

  bus.registerCloseHook(close);

  return { close };
}
