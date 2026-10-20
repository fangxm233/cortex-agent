import * as fs from 'node:fs';
import * as path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { lastCacheTouch } from './cache-touch.js';

const log = createLogger('claude-bridge');

/** The stub Claude Code itself writes when it clears an old tool result. */
export const CLEARED_TOOL_RESULT = '[Old tool result content cleared]';
const KEEP_RECENT_TOOL_RESULTS = 10;
/** Past the 1h prompt-cache TTL with margin; also the idle close, so an ordinary cold wake qualifies. */
const COLD_CACHE_MS = 65 * 60_000;
const MIN_CONTEXT_TOKENS = 100_000;
const MIN_CHARS_REMOVED = 40_000;
const BOUNDARY_NEEDLE = Buffer.from('"compact_boundary"');

type JsonRecord = Record<string, unknown>;

export interface ToolResultClearing {
  lines: string[];
  clearedCount: number;
  charsRemoved: number;
}

export type ColdResumeSkip = 'disabled' | 'warm' | 'unreadable' | 'small-context' | 'too-little' | 'write-failed';

export type ColdResumeClearing =
  | { cleared: true; clearedCount: number; charsRemoved: number }
  | { cleared: false; reason: ColdResumeSkip };

/** The file operations the clearing needs; replaced in tests. */
export interface TranscriptFs {
  readFileSync(path: string): Buffer;
  statSync(path: string): { mode: number };
  writeFileSync(path: string, data: Buffer, mode: number): void;
  appendFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

const nodeFs: TranscriptFs = {
  readFileSync: (p) => fs.readFileSync(p),
  statSync: (p) => fs.statSync(p),
  writeFileSync: (p, data, mode) => fs.writeFileSync(p, data, { mode }),
  appendFileSync: (p, data) => fs.appendFileSync(p, data),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (p) => fs.unlinkSync(p),
};

function parseRecord(line: string): JsonRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
  } catch {
    return null;
  }
}

function isCompactBoundary(line: string): boolean {
  if (!line.includes('"compact_boundary"')) return false;
  const record = parseRecord(line);
  return record?.type === 'system' && record.subtype === 'compact_boundary';
}

/** Index of the first line the resumed model still sees: right after the last compact boundary. */
function liveSegmentStart(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isCompactBoundary(lines[i])) return i + 1;
  }
  return 0;
}

function messageOf(record: JsonRecord | null): JsonRecord | null {
  const message = record?.message;
  return message !== null && typeof message === 'object' ? message as JsonRecord : null;
}

function toolResultBlocks(record: JsonRecord | null): JsonRecord[] {
  if (record?.type !== 'user' || record.isSidechain === true) return [];
  const content = messageOf(record)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is JsonRecord =>
    block !== null && typeof block === 'object' && (block as JsonRecord).type === 'tool_result');
}

interface ToolResultRef {
  line: number;
  record: JsonRecord;
  block: JsonRecord;
}

function collectToolResults(lines: readonly string[], start: number): ToolResultRef[] {
  const refs: ToolResultRef[] = [];
  for (let line = start; line < lines.length; line++) {
    if (!lines[line].includes('"tool_result"')) continue;
    const record = parseRecord(lines[line]);
    for (const block of toolResultBlocks(record)) refs.push({ line, record: record!, block });
  }
  return refs;
}

const PLACEHOLDER_CHARS = JSON.stringify(CLEARED_TOOL_RESULT).length;

/** Stub one block; returns the characters saved. A result no longer than the stub stays as it is. */
function clearBlock(block: JsonRecord): number {
  const saved = JSON.stringify(block.content ?? '').length - PLACEHOLDER_CHARS;
  if (saved <= 0) return 0;
  block.content = CLEARED_TOOL_RESULT;
  return saved;
}

/**
 * Stub the content of every tool result after the last compact boundary except the most recent
 * `keepRecent`. Only `message.content` of those blocks changes; every other line, and every field
 * of a changed line, is kept, and an unchanged line is returned as the same string.
 */
export function clearOldToolResults(
  lines: readonly string[],
  keepRecent: number = KEEP_RECENT_TOOL_RESULTS,
): ToolResultClearing {
  const refs = collectToolResults(lines, liveSegmentStart(lines));
  const changed = new Map<number, JsonRecord>();
  let clearedCount = 0;
  let charsRemoved = 0;
  for (const ref of refs.slice(0, Math.max(0, refs.length - keepRecent))) {
    const saved = clearBlock(ref.block);
    if (saved === 0) continue;
    changed.set(ref.line, ref.record);
    clearedCount++;
    charsRemoved += saved;
  }
  const out = lines.map((line, i) => (changed.has(i) ? JSON.stringify(changed.get(i)) : line));
  return { lines: out, clearedCount, charsRemoved };
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function assistantContextTokens(record: JsonRecord | null): number | null {
  if (record?.type !== 'assistant' || record.isSidechain === true) return null;
  const usage = messageOf(record)?.usage as JsonRecord | undefined;
  if (usage === null || typeof usage !== 'object') return null;
  const total = tokenCount(usage.input_tokens) + tokenCount(usage.cache_read_input_tokens)
    + tokenCount(usage.cache_creation_input_tokens);
  // A synthetic assistant message (an API error, an interrupted turn) reports all zeros.
  return total > 0 ? total : null;
}

/** The context size the last model request after the last compact boundary carried, if any. */
export function liveContextTokens(lines: readonly string[]): number | null {
  const start = liveSegmentStart(lines);
  for (let i = lines.length - 1; i >= start; i--) {
    if (!lines[i].includes('"usage"')) continue;
    const tokens = assistantContextTokens(parseRecord(lines[i]));
    if (tokens !== null) return tokens;
  }
  return null;
}

/**
 * Byte offset of the line holding the last compact boundary, or 0. Everything before it is outside
 * the resumed context, so it is copied through without being decoded.
 */
function liveSegmentOffset(buf: Buffer): number {
  let hit = buf.lastIndexOf(BOUNDARY_NEEDLE);
  while (hit !== -1) {
    const lineStart = buf.lastIndexOf(0x0a, hit) + 1;
    const newline = buf.indexOf(0x0a, hit);
    if (isCompactBoundary(buf.toString('utf8', lineStart, newline === -1 ? buf.length : newline))) return lineStart;
    if (lineStart === 0) return 0;
    hit = buf.lastIndexOf(BOUNDARY_NEEDLE, lineStart - 1);
  }
  return 0;
}

function coldGate(transcriptPath: string, backendSessionId: string, now: number): ColdResumeSkip | null {
  if (!getSettings().coldResumeClearToolResults) return 'disabled';
  const touched = lastCacheTouch(transcriptPath, backendSessionId);
  return touched === null || now - touched <= COLD_CACHE_MS ? 'warm' : null;
}

function readTranscript(transcriptPath: string, io: TranscriptFs): Buffer | null {
  try {
    return io.readFileSync(transcriptPath);
  } catch {
    return null;
  }
}

function planClearing(liveText: string): ToolResultClearing | ColdResumeSkip {
  const lines = liveText.split('\n');
  const tokens = liveContextTokens(lines);
  if (tokens === null || tokens < MIN_CONTEXT_TOKENS) return 'small-context';
  const clearing = clearOldToolResults(lines);
  return clearing.charsRemoved < MIN_CHARS_REMOVED ? 'too-little' : clearing;
}

/** Same-directory temp file, then rename over the transcript. Throws with the temp file removed. */
function replaceTranscript(transcriptPath: string, head: Buffer, liveText: string, io: TranscriptFs): void {
  const tmp = `${transcriptPath}.${process.pid}.clear.tmp`;
  try {
    io.writeFileSync(tmp, head, io.statSync(transcriptPath).mode & 0o777);
    io.appendFileSync(tmp, liveText);
    io.renameSync(tmp, transcriptPath);
  } catch (error) {
    try { io.unlinkSync(tmp); } catch { /* never created */ }
    throw error;
  }
}

function writeClearing(
  transcriptPath: string, head: Buffer, clearing: ToolResultClearing, io: TranscriptFs,
): ColdResumeClearing {
  try {
    replaceTranscript(transcriptPath, head, clearing.lines.join('\n'), io);
  } catch (error) {
    log.warn(`Cold-resume tool-result clearing failed for ${path.basename(transcriptPath)}, resuming it as is: ${(error as Error).message}`);
    return { cleared: false, reason: 'write-failed' };
  }
  return { cleared: true, clearedCount: clearing.clearedCount, charsRemoved: clearing.charsRemoved };
}

function clearTranscript(transcriptPath: string, io: TranscriptFs): ColdResumeClearing {
  const buf = readTranscript(transcriptPath, io);
  if (!buf) return { cleared: false, reason: 'unreadable' };
  const offset = liveSegmentOffset(buf);
  const live = buf.subarray(offset);
  if (!isUtf8(live)) return { cleared: false, reason: 'unreadable' };
  const plan = planClearing(live.toString('utf8'));
  if (typeof plan === 'string') return { cleared: false, reason: plan };
  return writeClearing(transcriptPath, buf.subarray(0, offset), plan, io);
}

/**
 * Before `--resume` of a session whose prompt cache has certainly expired, stub all but the most
 * recent tool results so the CLI re-sends a smaller context. The cache is cold either way, so no
 * cached prefix is lost; the turn's pre-run snapshot keeps the uncleared transcript for rewind. Any
 * failure leaves the transcript untouched.
 */
export function clearToolResultsForColdResume(
  transcriptPath: string,
  backendSessionId: string,
  now: number = Date.now(),
  io: TranscriptFs = nodeFs,
): ColdResumeClearing {
  const gated = coldGate(transcriptPath, backendSessionId, now);
  const outcome: ColdResumeClearing = gated ? { cleared: false, reason: gated } : clearTranscript(transcriptPath, io);
  if (outcome.cleared) {
    log.info(`Cleared ${outcome.clearedCount} old tool results before cold resume: ${backendSessionId.substring(0, 8)} (-${outcome.charsRemoved} chars)`);
  }
  return outcome;
}
