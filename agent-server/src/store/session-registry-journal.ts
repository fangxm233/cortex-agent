// input:  fs, readline, STORE_DIR, and append/compact journal callers
// output: JSONL session registry replay, append, compact, and migration helpers
// pos:    Low-level journal I/O for session registry state
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { STORE_DIR } from '@core/paths.js';

const REGISTRY_VERSION = 1;
const DEFAULT_YIELD_EVERY = 256;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const CHANNEL_REGISTRY_FILE = path.join(STORE_DIR, 'channel-registry.json');

export type SessionOrigin = 'direct' | 'thread' | 'scheduled';
export type SessionKind = 'local' | 'scheduled';

export interface SessionDeleteCleanup {
  claudeBackupPaths: string[];
}

export interface PendingSessionDelete {
  session: SessionRecord;
  cleanup: SessionDeleteCleanup;
}

/** Per-session browser opt-in (plan/embedded-browser.md §17). Absent/null means the session gets
 *  ZERO browser tools — the whole point of making this opt-in is that ~24 Playwright tools are not
 *  worth their context cost in a session that never browses. `device` names WHERE the browser runs;
 *  only 'server' exists until the cortex-client reverse channel lands. */
export interface SessionBrowserOption {
  device: string;
}

export interface SessionRecord {
  name: string;
  sessionId: string;
  projectId: string;
  channel: string;
  backend: string;
  kind: SessionKind;
  origin: SessionOrigin;
  createdAt: string;
  lastUsedAt: string;
  label: string | null;
  profileName: string | null;
  backendSessionId?: string | null;
  lastReadAt?: string | null;
  scheduleId?: string | null;
  /** Commission (long-task) membership — drives board grouping and [Commission] prompt injection.
   *  Bound once at commission finalize (DR-0037); absent/null for ordinary sessions. */
  commissionId?: string | null;
  /** Draft directory name (`_draft-<session name>`) while commission mode is on but the contract
   *  has not been named yet. Cleared at finalize, when commissionId is filled in. Mode is ON when
   *  either this or commissionId is set. */
  commissionDraft?: string | null;
  contextUsage?: unknown;
  browser?: SessionBrowserOption | null;
}

export type SessionRegistryEvent =
  | { v: 1; op: 'put'; id: string; record: SessionRecord }
  | { v: 1; op: 'delete-intent'; id: string; record: SessionRecord; cleanup?: SessionDeleteCleanup }
  | { v: 1; op: 'delete-commit'; id: string };

export interface SessionRegistryState {
  live: Map<string, SessionRecord>;
  pending: Map<string, PendingSessionDelete>;
  nameIndex: Map<string, string>;
  eventCount: number;
  fileSize: number;
}

export interface SessionRegistryJournalOptions {
  writeAppend?: (handle: fsp.FileHandle, line: string) => Promise<void>;
  shouldCompact?: (stats: { fileSize: number; eventCount: number; liveCount: number }) => boolean;
  onCompact?: () => void;
  yieldEvery?: number;
}

const THREAD_LABEL_RE = /^\[[^\]]+:[^\]]+\]$/;

export function createSessionRegistryState(): SessionRegistryState {
  return {
    live: new Map(),
    pending: new Map(),
    nameIndex: new Map(),
    eventCount: 0,
    fileSize: 0,
  };
}

export function legacyPathFor(filePath: string): string {
  return filePath.replace(/\.jsonl$/, '.json');
}

export function legacyBackupPathFor(filePath: string): string {
  return `${legacyPathFor(filePath)}.bak`;
}

export function deriveSessionOrigin(kind: SessionKind, label: string | null | undefined): SessionOrigin {
  if (kind === 'scheduled') return 'scheduled';
  if (label && THREAD_LABEL_RE.test(label)) return 'thread';
  return 'direct';
}

export function shouldCompactSessionRegistry(
  state: SessionRegistryState,
  options: SessionRegistryJournalOptions,
): boolean {
  const stats = {
    fileSize: state.fileSize,
    eventCount: state.eventCount,
    liveCount: state.live.size,
  };
  if (options.shouldCompact) return options.shouldCompact(stats);
  const threshold = Math.max(2048, state.live.size * 4);
  return state.fileSize > MAX_FILE_BYTES || state.eventCount > threshold;
}

export async function loadSessionRegistryState(
  filePath: string,
  options: SessionRegistryJournalOptions = {},
): Promise<SessionRegistryState> {
  await ensureJournalAuthority(filePath);
  await truncateUnterminatedTail(filePath);
  return replaySessionRegistry(filePath, options);
}

export async function appendSessionRegistryEvent(
  filePath: string,
  state: SessionRegistryState,
  event: SessionRegistryEvent,
  options: SessionRegistryJournalOptions = {},
): Promise<void> {
  assertAppendableEvent(state, event);
  const line = `${JSON.stringify(event)}\n`;
  const fileSize = await appendLineWithRollback(filePath, line, options.writeAppend);
  applyEvent(state, event);
  state.eventCount += 1;
  state.fileSize = fileSize;
}

export async function compactSessionRegistry(
  filePath: string,
  state: SessionRegistryState,
  options: SessionRegistryJournalOptions = {},
): Promise<void> {
  const events = compactedEvents(state);
  await replaceJournalFile(filePath, events);
  state.eventCount = events.length;
  state.fileSize = (await fsp.stat(filePath)).size;
  options.onCompact?.();
}

function compactedEvents(state: SessionRegistryState): SessionRegistryEvent[] {
  return [
    ...Array.from(state.live.values(), record => putEvent(record)),
    ...Array.from(state.pending.values(), entry => deleteIntentEvent(entry.session, entry.cleanup)),
  ];
}

function putEvent(record: SessionRecord): SessionRegistryEvent {
  return { v: 1, op: 'put', id: record.sessionId, record };
}

function deleteIntentEvent(record: SessionRecord, cleanup: SessionDeleteCleanup): SessionRegistryEvent {
  return { v: 1, op: 'delete-intent', id: record.sessionId, record, cleanup };
}

async function ensureJournalAuthority(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const journal = await statOrNull(filePath);
  const legacyPath = legacyPathFor(filePath);
  const legacy = await statOrNull(legacyPath);
  if (journal && legacy && journal.size === 0 && legacy.size > 0) {
    throw new Error(`Empty JSONL hides non-empty legacy registry: ${filePath}`);
  }
  if (journal) return;
  if (legacy) return migrateLegacyRegistry(filePath, legacyPath);
  await fsp.writeFile(filePath, '', { flag: 'a' });
}

async function migrateLegacyRegistry(filePath: string, legacyPath: string): Promise<void> {
  const raw = JSON.parse(await fsp.readFile(legacyPath, 'utf8')) as unknown;
  const state = createSessionRegistryState();
  for (const record of await legacySessions(raw)) applyPut(state, record);
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
  throw new Error(`Could not allocate session registry backup path: ${target}`);
}

async function legacySessions(raw: unknown): Promise<SessionRecord[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('legacy session registry must be a plain object');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return [];
  const format = detectLegacyFormat(entries);
  return format === 'new' ? newFormatSessions(entries) : await oldFormatSessions(entries);
}

function detectLegacyFormat(entries: Array<[string, unknown]>): 'new' | 'old' {
  let sawNew = false;
  let sawOld = false;
  for (const [, value] of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('legacy session registry entries must be objects');
    }
    const record = value as Record<string, unknown>;
    const hasName = Object.hasOwn(record, 'name');
    const hasSessionId = Object.hasOwn(record, 'sessionId');
    if (hasName) sawNew = true;
    else if (hasSessionId) sawOld = true;
    else throw new Error('legacy session registry entry format is unrecognizable');
    if (sawNew && sawOld) throw new Error('legacy session registry mixes old and new formats');
  }
  return sawNew ? 'new' : 'old';
}

function newFormatSessions(entries: Array<[string, unknown]>): SessionRecord[] {
  return entries.map(([id, value]) => normalizeNewFormatRecord(id, value));
}

function normalizeNewFormatRecord(id: string, value: unknown): SessionRecord {
  return assertNewFormatRecord(value, id);
}

async function oldFormatSessions(entries: Array<[string, unknown]>): Promise<SessionRecord[]> {
  const channelMap = await loadChannelReverseMap();
  const dedup = new Map<string, SessionRecord>();
  for (const [name, value] of entries) storeLegacyRecord(dedup, channelMap, name, value);
  return Array.from(dedup.values());
}

async function loadChannelReverseMap(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await fsp.readFile(CHANNEL_REGISTRY_FILE, 'utf8')) as Record<string, string>;
    return Object.fromEntries(Object.entries(raw).map(([project, channel]) => [channel, project]));
  } catch {
    return {};
  }
}

function storeLegacyRecord(
  dedup: Map<string, SessionRecord>,
  channelMap: Record<string, string>,
  name: string,
  value: unknown,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('legacy session registry entries must be objects');
  }
  const raw = value as Record<string, unknown>;
  const id = toStringValue(raw.sessionId);
  const next = normalizeLegacyRecord(name, channelMap, raw);
  const prev = dedup.get(id);
  if (!prev || prev.lastUsedAt <= next.lastUsedAt) dedup.set(id, next);
}

function normalizeLegacyRecord(
  name: string,
  channelMap: Record<string, string>,
  raw: Record<string, unknown>,
): SessionRecord {
  const kind = raw.kind === 'scheduled' ? 'scheduled' : 'local';
  const label = toNullableString(raw.label);
  return {
    name,
    sessionId: String(raw.sessionId),
    projectId: channelMap[toStringValue(raw.channel)] || 'general',
    channel: toStringValue(raw.channel),
    backend: toStringValue(raw.backend),
    kind,
    origin: deriveSessionOrigin(kind, label),
    createdAt: toStringValue(raw.createdAt),
    lastUsedAt: toStringValue(raw.lastUsedAt),
    label,
    profileName: toNullableString(raw.profileName),
    backendSessionId: toOptionalNullableString(raw.backendSessionId),
    lastReadAt: toOptionalNullableString(raw.lastReadAt),
    scheduleId: toOptionalNullableString(raw.scheduleId),
    contextUsage: raw.contextUsage,
  };
}

async function replaySessionRegistry(
  filePath: string,
  options: SessionRegistryJournalOptions,
): Promise<SessionRegistryState> {
  const state = createSessionRegistryState();
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

function parseEventLine(line: string, lineNo: number): SessionRegistryEvent {
  if (!line) throw new Error(`Malformed session registry line ${lineNo}: empty line`);
  let raw: unknown;
  try { raw = JSON.parse(line); }
  catch { throw new Error(`Malformed session registry line ${lineNo}`); }
  return normalizeEvent(raw, lineNo);
}

function normalizeEvent(raw: unknown, lineNo: number): SessionRegistryEvent {
  const row = raw as Record<string, unknown>;
  const version = row?.v;
  const op = row?.op;
  const id = row?.id;
  if (version !== REGISTRY_VERSION) throw new Error(`Unknown session registry version at line ${lineNo}`);
  if (typeof id !== 'string' || !id) throw new Error(`Malformed session registry id at line ${lineNo}`);
  if (op === 'put') return { v: 1, op, id, record: assertSessionRecord(row.record, id) };
  if (op === 'delete-intent') return {
    v: 1, op, id,
    record: assertSessionRecord(row.record, id),
    cleanup: normalizeDeleteCleanup(row.cleanup),
  };
  if (op === 'delete-commit') return { v: 1, op, id };
  throw new Error(`Unknown session registry op at line ${lineNo}`);
}

function normalizeDeleteCleanup(raw: unknown): SessionDeleteCleanup {
  if (raw === undefined) return { claudeBackupPaths: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid session registry delete cleanup');
  }
  const paths = (raw as Record<string, unknown>).claudeBackupPaths;
  if (!Array.isArray(paths) || paths.some((value) => typeof value !== 'string')) {
    throw new Error('Invalid session registry Claude backup paths');
  }
  return { claudeBackupPaths: [...new Set(paths)] };
}

function assertSessionRecord(raw: unknown, expectedId: string): SessionRecord {
  const row = raw as Record<string, unknown>;
  const record = {
    name: toStringValue(row?.name),
    sessionId: toStringValue(row?.sessionId),
    projectId: toStringValue(row?.projectId),
    channel: toStringValue(row?.channel),
    backend: toStringValue(row?.backend),
    kind: toKindValue(row?.kind),
    origin: toOriginValue(row?.origin),
    createdAt: toStringValue(row?.createdAt),
    lastUsedAt: toStringValue(row?.lastUsedAt),
    label: toNullableString(row?.label),
    profileName: toNullableString(row?.profileName),
    backendSessionId: toOptionalNullableString(row?.backendSessionId),
    lastReadAt: toOptionalNullableString(row?.lastReadAt),
    scheduleId: toOptionalNullableString(row?.scheduleId),
    commissionId: toOptionalNullableString(row?.commissionId),
    commissionDraft: toOptionalNullableString(row?.commissionDraft),
    contextUsage: row?.contextUsage,
    browser: toOptionalBrowserValue(row?.browser),
  } satisfies SessionRecord;
  return assertRecordId(record, expectedId);
}

function assertNewFormatRecord(raw: unknown, expectedId: string): SessionRecord {
  const row = raw as Record<string, unknown>;
  const kind = toKindValue(row?.kind);
  const label = toNullableString(row?.label);
  const record = {
    name: toStringValue(row?.name),
    sessionId: toStringValue(row?.sessionId),
    projectId: toStringValue(row?.projectId),
    channel: toStringValue(row?.channel),
    backend: toStringValue(row?.backend),
    kind,
    origin: row?.origin === undefined ? deriveSessionOrigin(kind, label) : toOriginValue(row?.origin),
    createdAt: toStringValue(row?.createdAt),
    lastUsedAt: toStringValue(row?.lastUsedAt),
    label,
    profileName: toNullableString(row?.profileName),
    backendSessionId: toOptionalNullableString(row?.backendSessionId),
    lastReadAt: toOptionalNullableString(row?.lastReadAt),
    scheduleId: toOptionalNullableString(row?.scheduleId),
    commissionId: toOptionalNullableString(row?.commissionId),
    commissionDraft: toOptionalNullableString(row?.commissionDraft),
    contextUsage: row?.contextUsage,
    browser: toOptionalBrowserValue(row?.browser),
  } satisfies SessionRecord;
  return assertRecordId(record, expectedId);
}

function assertRecordId(record: SessionRecord, expectedId: string): SessionRecord {
  if (record.sessionId !== expectedId) throw new Error(`Session registry record id mismatch for ${expectedId}`);
  return record;
}

function toStringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid session registry string field');
  return value;
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('Invalid session registry nullable string');
  return value;
}

function toOptionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return toNullableString(value);
}

/** Replay guard for the browser opt-in. Was missing from both asserts (fields not whitelisted
 *  here are silently dropped on replay), so every restart lost per-session browser opt-ins. */
function toOptionalBrowserValue(value: unknown): SessionBrowserOption | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const device = (value as Record<string, unknown>).device;
  if (typeof device !== 'string' || !device) throw new Error('Invalid session registry browser option');
  return { device };
}

function toKindValue(value: unknown): SessionKind {
  if (value === 'local' || value === 'scheduled') return value;
  throw new Error('Invalid session registry kind');
}

function toOriginValue(value: unknown): SessionOrigin {
  if (value === 'direct' || value === 'thread' || value === 'scheduled') return value;
  throw new Error('Invalid session registry origin');
}

function assertAppendableEvent(state: SessionRegistryState, event: SessionRegistryEvent): void {
  if (event.op === 'put') assertPutAllowed(state, event.record);
  if (event.op === 'delete-intent') assertDeleteIntentAppendable(state, event.record);
  if (event.op === 'delete-commit') assertDeleteCommitAllowed(state, event.id);
}

function assertPutAllowed(state: SessionRegistryState, record: SessionRecord): void {
  if (state.pending.has(record.sessionId)) {
    throw new Error(`Cannot revive pending-deletion session: ${record.sessionId}`);
  }
  const owner = state.nameIndex.get(record.name);
  if (owner && owner !== record.sessionId) throw new Error(`Duplicate live session name: ${record.name}`);
}

function assertDeleteIntentAppendable(state: SessionRegistryState, record: SessionRecord): void {
  const live = state.live.get(record.sessionId);
  if (!live) throw new Error(`Delete intent for missing session: ${record.sessionId}`);
  if (live.name !== record.name) throw new Error(`Delete intent record mismatch: ${record.sessionId}`);
}

function assertDeleteIntentReplayable(state: SessionRegistryState, record: SessionRecord): void {
  const live = state.live.get(record.sessionId);
  if (live && live.name !== record.name) {
    throw new Error(`Delete intent record mismatch: ${record.sessionId}`);
  }
}

function assertDeleteCommitAllowed(state: SessionRegistryState, sessionId: string): void {
  if (!state.pending.has(sessionId)) throw new Error(`Delete commit for missing intent: ${sessionId}`);
}

function applyEvent(state: SessionRegistryState, event: SessionRegistryEvent): void {
  if (event.op === 'put') return applyPut(state, event.record);
  if (event.op === 'delete-intent') return applyDeleteIntent(state, event.record, event.cleanup);
  applyDeleteCommit(state, event.id);
}

function applyPut(state: SessionRegistryState, record: SessionRecord): void {
  const previous = state.live.get(record.sessionId);
  if (previous && previous.name !== record.name) state.nameIndex.delete(previous.name);
  assertPutAllowed(state, record);
  state.live.set(record.sessionId, record);
  state.nameIndex.set(record.name, record.sessionId);
}

function applyDeleteIntent(
  state: SessionRegistryState,
  record: SessionRecord,
  cleanup: SessionDeleteCleanup = { claudeBackupPaths: [] },
): void {
  assertDeleteIntentReplayable(state, record);
  state.live.delete(record.sessionId);
  state.nameIndex.delete(record.name);
  state.pending.set(record.sessionId, { session: record, cleanup });
}

function applyDeleteCommit(state: SessionRegistryState, sessionId: string): void {
  assertDeleteCommitAllowed(state, sessionId);
  state.pending.delete(sessionId);
}

async function appendLineWithRollback(
  filePath: string,
  line: string,
  writer: SessionRegistryJournalOptions['writeAppend'],
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

async function replaceJournalFile(filePath: string, events: SessionRegistryEvent[]): Promise<void> {
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

async function writeReplacementFile(tmp: string, events: SessionRegistryEvent[]): Promise<void> {
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
