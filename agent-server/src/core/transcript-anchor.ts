import { open, readFile, truncate } from 'node:fs/promises';
import * as path from 'node:path';
import { parsePISessionFilename } from './pi-session-filename.js';
import type { TurnAnchor } from './types/transcript-anchor.js';

// Cut points in backend transcripts (see types/transcript-anchor.ts). A line is an entry when its
// top-level `uuid` (Claude Code) or `id` (PI) is a string; every other line is metadata.

const TAIL_CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

function entryIdOf(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (typeof row.uuid === 'string') return row.uuid;
    return typeof row.id === 'string' ? row.id : null;
  } catch {
    return null;
  }
}

function lastIdIn(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const id = entryIdOf(lines[i]);
    if (id) return id;
  }
  return null;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The newest entry id in `file`, read backwards from its end; null when it holds none. */
export async function lastEntryId(file: string): Promise<string | null> {
  const handle = await open(file, 'r');
  try {
    let end = (await handle.stat()).size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      const buf = Buffer.concat([chunk, carry]);
      end = start;
      // Bytes before the first newline belong to a line that starts in an earlier chunk.
      const newline = start === 0 ? -1 : buf.indexOf(NEWLINE);
      if (start > 0 && newline === -1) { carry = buf; continue; }
      const id = lastIdIn(buf.toString('utf8', newline + 1));
      if (id) return id;
      carry = buf.subarray(0, Math.max(0, newline));
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** An anchor at the current end of `file`. Null when the file is missing or holds no entry. */
export async function anchorAtEnd(file: string): Promise<TurnAnchor | null> {
  try {
    const id = await lastEntryId(file);
    return id ? { file, after: id } : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function lineEnd(buf: Buffer, from: number): number {
  const end = buf.indexOf(NEWLINE, from);
  return end === -1 ? buf.length : end;
}

/** Start and end (exclusive of its newline) of the line that is entry `id`; null when absent. */
function findEntryLine(buf: Buffer, id: string): { start: number; end: number } | null {
  const needle = Buffer.from(JSON.stringify(id));
  for (let hit = buf.indexOf(needle); hit !== -1; hit = buf.indexOf(needle, hit + needle.length)) {
    const start = buf.lastIndexOf(NEWLINE, hit) + 1;
    const end = lineEnd(buf, hit);
    if (entryIdOf(buf.toString('utf8', start, end)) === id) return { start, end };
  }
  return null;
}

/** Past `end`'s newline and every following id-less line, up to the next entry. */
function skipMetadata(buf: Buffer, end: number): number {
  let offset = Math.min(buf.length, end + 1);
  while (offset < buf.length) {
    const next = lineEnd(buf, offset);
    if (entryIdOf(buf.toString('utf8', offset, next)) !== null) break;
    offset = Math.min(buf.length, next + 1);
  }
  return offset;
}

/** Byte length `anchor.file` keeps when cut back to the anchor; null when its entry is absent. */
async function anchorOffset(anchor: TurnAnchor): Promise<number | null> {
  const buf = await readFile(anchor.file);
  const id = 'after' in anchor ? anchor.after : anchor.before;
  const line = findEntryLine(buf, id);
  if (!line) return null;
  return 'after' in anchor ? skipMetadata(buf, line.end) : line.start;
}

/** Whether `anchor` still points at an entry in its file. */
export async function anchorResolves(anchor: TurnAnchor): Promise<boolean> {
  try {
    return await anchorOffset(anchor) !== null;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Cut the transcript back to `anchor`. False, with the file untouched, when the file or entry is gone. */
export async function truncateToAnchor(anchor: TurnAnchor): Promise<boolean> {
  let offset: number | null;
  try {
    offset = await anchorOffset(anchor);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (offset === null) return false;
  await truncate(anchor.file, offset);
  return true;
}

/** True when `file` is the transcript of backend session `backendSessionId`. Claude's `<id>.jsonl`
 *  is PI's canonical form, so one parser covers both backends. */
export function ownsTranscript(file: string, backendSessionId: string): boolean {
  const parsed = parsePISessionFilename(path.basename(file));
  return !!parsed && parsed.backupTurn === null && parsed.sessionId === backendSessionId;
}
