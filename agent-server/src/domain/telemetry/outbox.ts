import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { OUTBOX_FILE } from './paths.js';
import { TelemetryEventSchema, type TelemetryEvent } from './schema.js';

/** The outbox never grows past this; the oldest lines go first. */
export const OUTBOX_MAX_BYTES = 2 * 1024 * 1024;
const TRIM_TARGET_BYTES = Math.floor(OUTBOX_MAX_BYTES * 0.75);

function sendingFile(file: string): string {
  return `${file.slice(0, -'.jsonl'.length)}.sending.jsonl`;
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

/** Keep the newest lines that fit in `budget` bytes. */
export function newestWithin(lines: string[], budget: number): string[] {
  let used = 0;
  let start = lines.length;
  while (start > 0 && used + Buffer.byteLength(lines[start - 1]) + 1 <= budget) {
    start -= 1;
    used += Buffer.byteLength(lines[start]) + 1;
  }
  return lines.slice(start);
}

function writeLines(file: string, lines: string[]): void {
  if (lines.length === 0) return void rmSync(file, { force: true });
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function enforceCap(file: string, maxBytes: number): void {
  if (statSync(file).size <= maxBytes) return;
  writeLines(file, newestWithin(readLines(file), Math.floor(maxBytes * 0.75)));
}

/**
 * Append one event synchronously, so a process about to die still leaves it on disk. Invalid
 * events are refused. Never throws.
 */
export function appendToOutbox(
  event: TelemetryEvent, file: string = OUTBOX_FILE, maxBytes = OUTBOX_MAX_BYTES,
): boolean {
  const parsed = TelemetryEventSchema.safeParse(event);
  if (!parsed.success) return false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(parsed.data)}\n`, 'utf8');
    enforceCap(file, maxBytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything waiting to be sent, oldest first. New appends go to a fresh outbox file meanwhile
 * (another process may append while an upload runs); `settleOutbox` writes back what is left.
 */
export function takeOutbox(file: string = OUTBOX_FILE): TelemetryEvent[] {
  const sending = sendingFile(file);
  if (existsSync(file)) {
    const moved = `${file}.${process.pid}.tmp`;
    try {
      renameSync(file, moved);
      writeLines(sending, newestWithin([...readLines(sending), ...readLines(moved)], TRIM_TARGET_BYTES));
      rmSync(moved, { force: true });
    } catch { /* leave both files for the next attempt */ }
  }
  return readLines(sending).flatMap((line) => parseEvent(line));
}

function parseEvent(line: string): TelemetryEvent[] {
  try {
    const parsed = TelemetryEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
}

/** Record what an upload attempt could not deliver; an empty list clears the pending file. */
export function settleOutbox(unsent: TelemetryEvent[], file: string = OUTBOX_FILE): void {
  try {
    writeLines(sendingFile(file), unsent.map((event) => JSON.stringify(event)));
  } catch { /* retried next time */ }
}

export function wipeOutbox(file: string = OUTBOX_FILE): void {
  rmSync(file, { force: true });
  rmSync(sendingFile(file), { force: true });
}
