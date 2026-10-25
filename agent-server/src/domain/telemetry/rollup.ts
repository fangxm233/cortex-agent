import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isTelemetryActive } from './gate.js';
import { ROLLUP_PREFIX, rollupFile, TELEMETRY_DIR } from './paths.js';
import { emptyRollup, type RawRollup } from './rollup-types.js';

/** Event-loop windows kept per day for the median (one per minute). */
const MAX_LOOP_SAMPLES = 1_440;
/** Finished days older than this are dropped instead of uploaded. */
const MAX_BACKLOG_DAYS = 7;

let current: RawRollup | null = null;
let dir = TELEMETRY_DIR;
let clock: () => number = Date.now;

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Tests point the store at their own directory and clock. */
export function configureRollupStore(next: { dir?: string; now?: () => number }): void {
  current = null;
  dir = next.dir ?? TELEMETRY_DIR;
  clock = next.now ?? Date.now;
}

function readRollup(file: string): RawRollup | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RawRollup;
  } catch {
    return null;
  }
}

function writeRollup(rollup: RawRollup): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(rollupFile(rollup.day, dir), JSON.stringify(rollup), 'utf8');
  } catch { /* retried at the next persist */ }
}

/** Today's rollup, rotating the previous day to disk when the UTC day changed. */
function today(): RawRollup {
  const day = utcDay(clock());
  if (current?.day === day) return current;
  if (current) writeRollup(current);
  const stored = readRollup(rollupFile(day, dir));
  current = stored?.day === day ? { ...emptyRollup(day), ...stored } : emptyRollup(day);
  return current;
}

/** Apply one change to today's aggregates; a no-op while telemetry is inactive. */
export function updateRollup(change: (rollup: RawRollup) => void): void {
  if (!isTelemetryActive()) return;
  try { change(today()); } catch { /* a collector bug never reaches the caller */ }
}

export function recordEventLoopP99(rollup: RawRollup, p99Ms: number): void {
  rollup.perf.eventLoopP99s.push(p99Ms);
  if (rollup.perf.eventLoopP99s.length > MAX_LOOP_SAMPLES) rollup.perf.eventLoopP99s.shift();
}

export function persistRollup(): void {
  if (current) writeRollup(current);
}

function rollupDays(): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(ROLLUP_PREFIX) && name.endsWith('.json'))
      .map((name) => name.slice(ROLLUP_PREFIX.length, -'.json'.length));
  } catch {
    return [];
  }
}

/** Finished days, oldest first; their files are removed by `dropRollupDay` once queued. */
export function finishedRollups(now: number = clock()): RawRollup[] {
  const todayKey = utcDay(now);
  if (current && current.day !== todayKey) persistRollup();
  if (current?.day !== todayKey) current = null;
  const oldest = utcDay(now - MAX_BACKLOG_DAYS * 24 * 60 * 60 * 1000);
  const days = rollupDays().filter((day) => day < todayKey).sort();
  for (const day of days.filter((d) => d < oldest)) dropRollupDay(day);
  return days.filter((day) => day >= oldest).flatMap((day) => {
    const rollup = readRollup(rollupFile(day, dir));
    return rollup?.day === day ? [{ ...emptyRollup(day), ...rollup }] : [];
  });
}

export function dropRollupDay(day: string): void {
  rmSync(rollupFile(day, dir), { force: true });
}

export function wipeRollups(): void {
  current = null;
  for (const day of rollupDays()) dropRollupDay(day);
}

export function rollupDir(): string {
  return path.resolve(dir);
}
