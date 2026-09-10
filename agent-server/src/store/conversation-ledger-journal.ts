// input:  conversation-ledger.jsonl, legacy conversation-ledger.json, channel conversation records
// output: JSONL ledger replay, append, compact, and one-time legacy migration
// pos:    Low-level journal I/O for the channel turn ledger
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const LEDGER_VERSION = 1;
const DEFAULT_YIELD_EVERY = 256;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export type TurnStatus = 'processing' | 'completed' | 'superseded';

export interface LedgerTurn {
  turnIndex: number;
  userMessageTs: string;
  userMessageText: string;
  statusMessageTs: string | null;
  responseMessageTimestamps: string[];
  executionId: string | null;
  backupPath: string | null;
  status: TurnStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelConversation {
  sessionId: string | null;
  sessionName: string | null;
  backend: string;
  /** Profile name used when the conversation was created or switched — needed
   *  by !new / pre-close hooks to resume the session with the same profile. */
  profileName: string | null;
  turns: LedgerTurn[];
  updatedAt: string;
}

export type LedgerData = Record<string, ChannelConversation>;

/**
 * A channel is the unit of change: every mutation but the bulk retention sweeps touches exactly
 * one, so one `put` per mutation is the whole win. Per-turn deltas would shrink a write from ~1.2KB
 * to ~450B but would make replay re-implement every mutation's semantics, which is where the bugs
 * would live.
 */
export type ConversationLedgerEvent =
  | { v: 1; op: 'put'; id: string; record: ChannelConversation }
  | { v: 1; op: 'delete'; id: string };

export interface ConversationLedgerState {
  channels: Map<string, ChannelConversation>;
  eventCount: number;
  fileSize: number;
}

export interface ConversationLedgerJournalOptions {
  writeAppend?: (handle: fsp.FileHandle, line: string) => Promise<void>;
  shouldCompact?: (stats: { fileSize: number; eventCount: number; liveCount: number }) => boolean;
  onCompact?: () => void;
  yieldEvery?: number;
}

export function createConversationLedgerState(): ConversationLedgerState {
  return { channels: new Map(), eventCount: 0, fileSize: 0 };
}

export function legacyPathFor(filePath: string): string {
  return filePath.replace(/\.jsonl$/, '.json');
}

export function legacyBackupPathFor(filePath: string): string {
  return `${legacyPathFor(filePath)}.bak`;
}

export function shouldCompactConversationLedger(
  state: ConversationLedgerState,
  options: ConversationLedgerJournalOptions,
): boolean {
  const stats = { fileSize: state.fileSize, eventCount: state.eventCount, liveCount: state.channels.size };
  if (options.shouldCompact) return options.shouldCompact(stats);
  const threshold = Math.max(2048, state.channels.size * 4);
  return state.fileSize > MAX_FILE_BYTES || state.eventCount > threshold;
}

export async function loadConversationLedgerState(
  filePath: string,
  options: ConversationLedgerJournalOptions = {},
): Promise<ConversationLedgerState> {
  await ensureJournalAuthority(filePath);
  await truncateUnterminatedTail(filePath);
  return replayConversationLedger(filePath, options);
}

export async function appendConversationLedgerEvent(
  filePath: string,
  state: ConversationLedgerState,
  event: ConversationLedgerEvent,
  options: ConversationLedgerJournalOptions = {},
): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  const fileSize = await appendLineWithRollback(filePath, line, options.writeAppend);
  applyEvent(state, event);
  state.eventCount += 1;
  state.fileSize = fileSize;
}

export async function compactConversationLedger(
  filePath: string,
  state: ConversationLedgerState,
  options: ConversationLedgerJournalOptions = {},
): Promise<void> {
  const events = compactedEvents(state);
  await replaceJournalFile(filePath, events);
  state.eventCount = events.length;
  state.fileSize = (await fsp.stat(filePath)).size;
  options.onCompact?.();
}

export function putEvent(channel: string, record: ChannelConversation): ConversationLedgerEvent {
  return { v: 1, op: 'put', id: channel, record };
}

export function deleteEvent(channel: string): ConversationLedgerEvent {
  return { v: 1, op: 'delete', id: channel };
}

function compactedEvents(state: ConversationLedgerState): ConversationLedgerEvent[] {
  return Array.from(state.channels, ([channel, record]) => putEvent(channel, record));
}

function applyEvent(state: ConversationLedgerState, event: ConversationLedgerEvent): void {
  if (event.op === 'put') state.channels.set(event.id, event.record);
  else state.channels.delete(event.id);
}

// --- Replay ---------------------------------------------------------------

async function replayConversationLedger(
  filePath: string,
  options: ConversationLedgerJournalOptions,
): Promise<ConversationLedgerState> {
  const state = createConversationLedgerState();
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    count += 1;
    applyEvent(state, parseEventLine(line, count));
    if (count % (options.yieldEvery ?? DEFAULT_YIELD_EVERY) === 0) await yieldControl();
  }
  state.eventCount = count;
  state.fileSize = (await fsp.stat(filePath)).size;
  return state;
}

function parseEventLine(line: string, lineNo: number): ConversationLedgerEvent {
  if (!line) throw new Error(`Malformed conversation ledger line ${lineNo}: empty line`);
  let raw: unknown;
  try { raw = JSON.parse(line); }
  catch { throw new Error(`Malformed conversation ledger line ${lineNo}`); }
  return normalizeEvent(raw, lineNo);
}

function normalizeEvent(raw: unknown, lineNo: number): ConversationLedgerEvent {
  const row = raw as Record<string, unknown>;
  if (row?.v !== LEDGER_VERSION) throw new Error(`Unknown conversation ledger version at line ${lineNo}`);
  const id = row?.id;
  if (typeof id !== 'string' || !id) throw new Error(`Malformed conversation ledger channel at line ${lineNo}`);
  if (row.op === 'delete') return deleteEvent(id);
  if (row.op === 'put') return putEvent(id, assertChannelConversation(row.record, `line ${lineNo}`));
  throw new Error(`Unknown conversation ledger op at line ${lineNo}`);
}

// --- Record validation ----------------------------------------------------
//
// Strict on types, forgiving about a MISSING nullable field (it reads as null — what the repo would
// have written). A field present with the wrong type is a corrupt record and says so: silently
// dropping unrecognised fields is how the session registry lost every browser opt-in on restart.

function assertChannelConversation(value: unknown, where: string): ChannelConversation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid conversation ledger record at ${where}`);
  }
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.turns)) throw new Error(`Invalid conversation ledger turns at ${where}`);
  return {
    sessionId: nullableString(row.sessionId, `${where} sessionId`),
    sessionName: nullableString(row.sessionName, `${where} sessionName`),
    backend: requiredString(row.backend, `${where} backend`),
    profileName: nullableString(row.profileName, `${where} profileName`),
    turns: row.turns.map((turn, index) => assertLedgerTurn(turn, `${where} turn ${index}`)),
    updatedAt: requiredString(row.updatedAt, `${where} updatedAt`),
  };
}

function assertLedgerTurn(value: unknown, where: string): LedgerTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid conversation ledger turn at ${where}`);
  }
  const row = value as Record<string, unknown>;
  if (typeof row.turnIndex !== 'number' || !Number.isInteger(row.turnIndex)) {
    throw new Error(`Invalid conversation ledger turnIndex at ${where}`);
  }
  return {
    turnIndex: row.turnIndex,
    userMessageTs: requiredString(row.userMessageTs, `${where} userMessageTs`),
    userMessageText: requiredString(row.userMessageText, `${where} userMessageText`),
    statusMessageTs: nullableString(row.statusMessageTs, `${where} statusMessageTs`),
    responseMessageTimestamps: assertStringArray(row.responseMessageTimestamps, `${where} responseMessageTimestamps`),
    executionId: nullableString(row.executionId, `${where} executionId`),
    backupPath: nullableString(row.backupPath, `${where} backupPath`),
    status: assertTurnStatus(row.status, where),
    createdAt: requiredString(row.createdAt, `${where} createdAt`),
    updatedAt: requiredString(row.updatedAt, `${where} updatedAt`),
  };
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid conversation ledger string at ${where}`);
  return value;
}

function nullableString(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Invalid conversation ledger nullable string at ${where}`);
  return value;
}

function assertStringArray(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`Invalid conversation ledger string array at ${where}`);
  }
  return [...value] as string[];
}

function assertTurnStatus(value: unknown, where: string): TurnStatus {
  if (value === 'processing' || value === 'completed' || value === 'superseded') return value;
  throw new Error(`Invalid conversation ledger turn status at ${where}`);
}

// --- Legacy migration -----------------------------------------------------

async function ensureJournalAuthority(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const journal = await statOrNull(filePath);
  const legacyPath = legacyPathFor(filePath);
  const legacy = await statOrNull(legacyPath);
  if (journal && legacy && journal.size === 0 && legacy.size > 0) {
    throw new Error(`Empty JSONL hides non-empty legacy conversation ledger: ${filePath}`);
  }
  if (journal) return;
  if (legacy) return migrateLegacyLedger(filePath, legacyPath);
  await fsp.writeFile(filePath, '', { flag: 'a' });
}

/** Normalise everything BEFORE touching the disk, so a legacy file this cannot read is left exactly
 *  as it was rather than half-converted. */
async function migrateLegacyLedger(filePath: string, legacyPath: string): Promise<void> {
  const raw = JSON.parse(await fsp.readFile(legacyPath, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('legacy conversation ledger must be a plain object');
  }
  const state = createConversationLedgerState();
  for (const [channel, record] of Object.entries(raw as Record<string, unknown>)) {
    state.channels.set(channel, assertChannelConversation(record, `legacy channel ${channel}`));
  }
  await writeLegacyBackup(legacyPath, legacyBackupPathFor(filePath));
  await replaceJournalFile(filePath, compactedEvents(state));
}

async function writeLegacyBackup(source: string, target: string): Promise<void> {
  const resolved = await uniqueBackupPath(target);
  await fsp.copyFile(source, resolved, fs.constants.COPYFILE_EXCL);
}

async function uniqueBackupPath(target: string): Promise<string> {
  if (await statOrNull(target) === null) return target;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `${target}.${stamp}.${attempt + 1}`;
    if (await statOrNull(candidate) === null) return candidate;
  }
  throw new Error(`Could not allocate conversation ledger backup path: ${target}`);
}

// --- File primitives ------------------------------------------------------

async function appendLineWithRollback(
  filePath: string,
  line: string,
  writer: ConversationLedgerJournalOptions['writeAppend'],
): Promise<number> {
  const handle = await fsp.open(filePath, 'a+');
  const size = (await handle.stat()).size;
  try {
    await (writer ? writer(handle, line) : handle.writeFile(line, 'utf8'));
    await handle.sync();
    return (await handle.stat()).size;
  } catch (error) {
    await handle.truncate(size);
    await handle.sync();
    throw error;
  } finally {
    await handle.close();
  }
}

async function replaceJournalFile(filePath: string, events: ConversationLedgerEvent[]): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeReplacementFile(tmp, events);
    await fsp.rename(tmp, filePath);
    await syncParentDir(filePath);
  } catch (error) {
    await removeIfExists(tmp);
    throw error;
  }
}

async function writeReplacementFile(tmp: string, events: ConversationLedgerEvent[]): Promise<void> {
  const handle = await fsp.open(tmp, 'w');
  try {
    for (const event of events) await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncParentDir(filePath: string): Promise<void> {
  const handle = await fsp.open(path.dirname(filePath), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fsp.rm(filePath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** A process killed mid-append leaves a partial last line. It is not a record yet, so drop it —
 *  the same hazard, and the same cure, as the session registry journal. */
async function truncateUnterminatedTail(filePath: string): Promise<void> {
  const handle = await fsp.open(filePath, 'r+');
  try {
    const size = (await handle.stat()).size;
    const nextSize = await truncatedSize(handle, size);
    if (nextSize === size) return;
    await handle.truncate(nextSize);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncatedSize(handle: fsp.FileHandle, size: number): Promise<number> {
  if (size === 0) return 0;
  const tail = Buffer.alloc(Math.min(size, 4096));
  await handle.read(tail, 0, tail.length, size - tail.length);
  if (tail[tail.length - 1] === 0x0a) return size;
  const newline = tail.lastIndexOf(0x0a);
  if (newline >= 0) return size - tail.length + newline + 1;
  return findTruncationOffset(handle, size - tail.length);
}

async function findTruncationOffset(handle: fsp.FileHandle, offset: number): Promise<number> {
  let cursor = offset;
  while (cursor > 0) {
    const chunkSize = Math.min(cursor, 4096);
    const chunk = Buffer.alloc(chunkSize);
    cursor -= chunkSize;
    await handle.read(chunk, 0, chunkSize, cursor);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) return cursor + newline + 1;
  }
  return 0;
}

async function statOrNull(filePath: string): Promise<fs.Stats | null> {
  try { return await fsp.stat(filePath); }
  catch { return null; }
}

async function yieldControl(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}
