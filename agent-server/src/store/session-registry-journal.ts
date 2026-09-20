// input:  fs, readline, STORE_DIR, and append/compact journal callers
// output: JSONL session registry replay, append, compact, and migration helpers
//         (records + channel bindings + per-CHANNEL conversation header & turn history;
//          events: put/patch/delete-*/bind/unbind/turn/conversation)
// pos:    Low-level journal I/O for session registry state — the single owner of session identity
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

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
  /** Which commission binding the `[Commission]` prompt block has already been delivered for —
   *  `draft:<dir>` or `active:<commissionId>` (DR-0037 v4). The block used to be a first-turn-only
   *  injection, which meant a session that entered the mode (or bound its contract) MID-session
   *  never received it at all. Comparing this marker against the current binding is what makes the
   *  block follow the state instead of the session's age; compaction clears it, because compaction
   *  is what removes the already-delivered copy from backend history. */
  commissionBlockFor?: string | null;
  contextUsage?: unknown;
  browser?: SessionBrowserOption | null;
}

/** Copied VERBATIM from store/conversation-ledger-repo.ts:9-22 (B.T1). The journal owns turn history
 *  now, but must NOT import the ledger module (dependency direction). Keep this in lock-step with the
 *  ledger's LedgerTurn until the ledger is retired in a later task. */
export type TurnStatus = 'processing' | 'completed' | 'superseded';

export interface TurnRecord {
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

/** Per-channel conversation header — the identity of the conversation currently hosted on a channel,
 *  independent of the live session record. Turns live in `turns` keyed by the same channel. Both are
 *  dropped together on `conversation clear` and on `delete-commit` (for every channel bound to the
 *  committed session). `sessionId`/`sessionName` are null before the first backend session lands. */
export interface ConversationHeader {
  sessionId: string | null;
  sessionName: string | null;
  backend: string;
  profileName: string | null;
  updatedAt: string;
}

/** Header mutation payload for a `conversation set` event. A key present overwrites; a key absent is
 *  left untouched (the reducer merges onto the previous header, or onto a null base for a new one). */
export type ConversationFields = Partial<ConversationHeader>;

/** Patch payload: only the record keys a `patch` may carry. `name`/`sessionId` are identity and
 *  never travel in a patch (the event keys off them). A key set to `null` means "store null"; a key
 *  listed in `unset` is deleted (→ `undefined`); a key in neither is untouched. */
export type SessionPatchFields = Partial<Omit<SessionRecord, 'name' | 'sessionId'>>;
export type SessionPatchUnsetKey = keyof SessionPatchFields;

export type SessionRegistryEvent =
  | { v: 1; op: 'put'; id: string; record: SessionRecord }
  | { v: 1; op: 'delete-intent'; id: string; record: SessionRecord; cleanup?: SessionDeleteCleanup }
  | { v: 1; op: 'delete-commit'; id: string }
  | { v: 1; op: 'patch'; id: string; name: string; fields: SessionPatchFields; unset?: SessionPatchUnsetKey[] }
  | { v: 1; op: 'bind'; channel: string; sessionId: string }
  | { v: 1; op: 'unbind'; channel: string }
  | { v: 1; op: 'turn'; channel: string; kind: 'begin'; turn: TurnRecord }
  | { v: 1; op: 'turn'; channel: string; kind: 'patch'; turnIndex: number; fields: Partial<TurnRecord> }
  | { v: 1; op: 'turn'; channel: string; kind: 'truncate'; fromIndex: number }
  | { v: 1; op: 'turn'; channel: string; kind: 'clear' }
  | { v: 1; op: 'conversation'; channel: string; kind: 'set'; fields: ConversationFields }
  | { v: 1; op: 'conversation'; channel: string; kind: 'clear' };

export interface SessionRegistryState {
  live: Map<string, SessionRecord>;
  pending: Map<string, PendingSessionDelete>;
  nameIndex: Map<string, string>;
  /** channel → sessionId of the conversation session hosted on that channel (an explicit index; a
   *  channel can host several sessions but binds to one at a time). A free map: bind never checks
   *  liveness (an unknown or pending session id may be bound). Cleared on delete-commit. */
  bindings: Map<string, string>;
  /** channel → ordered turn history for the conversation hosted on that channel. Independent of
   *  liveness; dropped on `conversation clear` and on delete-commit (for every bound channel). */
  turns: Map<string, TurnRecord[]>;
  /** channel → conversation header (session identity of the hosted conversation). Dropped with the
   *  turns on `conversation clear` and on delete-commit (for every bound channel). */
  conversations: Map<string, ConversationHeader>;
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
    bindings: new Map(),
    turns: new Map(),
    conversations: new Map(),
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
  // Lowered from 2048 (B.T1): patch/turn ticks are cheap, so compact sooner to keep the tail small.
  const threshold = Math.max(512, state.live.size * 4);
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
  const events: SessionRegistryEvent[] = [];
  for (const record of state.live.values()) events.push(putEvent(record));
  for (const entry of state.pending.values()) events.push(deleteIntentEvent(entry.session, entry.cleanup));
  // Bindings, conversation headers and turns are channel-keyed and re-materialised as-is: bind is a
  // free map (not filtered by liveness), and headers/turns outlive the session record they name.
  // Order: puts → delete-intents → binds → conversation headers → turns.
  for (const [channel, sessionId] of state.bindings) {
    events.push({ v: 1, op: 'bind', channel, sessionId });
  }
  for (const [channel, header] of state.conversations) {
    events.push({ v: 1, op: 'conversation', channel, kind: 'set', fields: header });
  }
  for (const [channel, turns] of state.turns) {
    for (const turn of turns) events.push({ v: 1, op: 'turn', channel, kind: 'begin', turn });
  }
  return events;
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
  if (version !== REGISTRY_VERSION) throw new Error(`Unknown session registry version at line ${lineNo}`);
  if (op === 'put') { const id = requireId(row, lineNo); return { v: 1, op, id, record: assertSessionRecord(row.record, id) }; }
  if (op === 'delete-intent') {
    const id = requireId(row, lineNo);
    return { v: 1, op, id, record: assertSessionRecord(row.record, id), cleanup: normalizeDeleteCleanup(row.cleanup) };
  }
  if (op === 'delete-commit') return { v: 1, op, id: requireId(row, lineNo) };
  if (op === 'patch') return normalizePatchEvent(row, lineNo);
  if (op === 'bind') return normalizeBindEvent(row, lineNo);
  if (op === 'unbind') return { v: 1, op: 'unbind', channel: requireField(row, 'channel', lineNo) };
  if (op === 'conversation') return normalizeConversationEvent(row, lineNo);
  if (op === 'turn') return normalizeTurnEvent(row, lineNo);
  throw new Error(`Unknown session registry op at line ${lineNo}`);
}

function requireId(row: Record<string, unknown>, lineNo: number): string {
  const id = row?.id;
  if (typeof id !== 'string' || !id) throw new Error(`Malformed session registry id at line ${lineNo}`);
  return id;
}

function requireField(row: Record<string, unknown>, key: string, lineNo: number): string {
  const value = row?.[key];
  if (typeof value !== 'string' || !value) throw new Error(`Malformed session registry ${key} at line ${lineNo}`);
  return value;
}

function normalizePatchEvent(row: Record<string, unknown>, lineNo: number): SessionRegistryEvent {
  const id = requireId(row, lineNo);
  const name = requireField(row, 'name', lineNo);
  return { v: 1, op: 'patch', id, name, fields: assertPatchFields(row.fields), ...normalizeUnset(row.unset, lineNo) };
}

function normalizeUnset(raw: unknown, lineNo: number): { unset?: SessionPatchUnsetKey[] } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.some(value => !PATCH_KEY_SET.has(value as string))) {
    throw new Error(`Invalid session registry patch unset at line ${lineNo}`);
  }
  return raw.length ? { unset: raw as SessionPatchUnsetKey[] } : {};
}

function normalizeBindEvent(row: Record<string, unknown>, lineNo: number): SessionRegistryEvent {
  return {
    v: 1,
    op: 'bind',
    channel: requireField(row, 'channel', lineNo),
    sessionId: requireField(row, 'sessionId', lineNo),
  };
}

function normalizeTurnEvent(row: Record<string, unknown>, lineNo: number): SessionRegistryEvent {
  const channel = requireField(row, 'channel', lineNo);
  const kind = row?.kind;
  if (kind === 'begin') return { v: 1, op: 'turn', channel, kind, turn: assertTurnRecord(row.turn) };
  if (kind === 'patch') return { v: 1, op: 'turn', channel, kind, turnIndex: toNumberValue(row.turnIndex), fields: assertPartialTurn(row.fields) };
  if (kind === 'truncate') return { v: 1, op: 'turn', channel, kind, fromIndex: toNumberValue(row.fromIndex) };
  if (kind === 'clear') return { v: 1, op: 'turn', channel, kind };
  throw new Error(`Unknown session registry turn kind at line ${lineNo}`);
}

function normalizeConversationEvent(row: Record<string, unknown>, lineNo: number): SessionRegistryEvent {
  const channel = requireField(row, 'channel', lineNo);
  const kind = row?.kind;
  if (kind === 'set') return { v: 1, op: 'conversation', channel, kind, fields: assertConversationFields(row.fields) };
  if (kind === 'clear') return { v: 1, op: 'conversation', channel, kind };
  throw new Error(`Unknown session registry conversation kind at line ${lineNo}`);
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
    commissionBlockFor: toOptionalNullableString(row?.commissionBlockFor),
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
    commissionBlockFor: toOptionalNullableString(row?.commissionBlockFor),
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

function toNumberValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid session registry number field');
  return value;
}

/** Strict nullable string for turn fields: `null` stays null, a string stays a string, anything
 *  else (including undefined) is rejected. Unlike `toNullableString`, `''` is preserved. */
function toTurnNullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error('Invalid session registry turn nullable string');
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error('Invalid session registry string array');
  }
  return [...(value as string[])];
}

function toTurnStatus(value: unknown): TurnStatus {
  if (value === 'processing' || value === 'completed' || value === 'superseded') return value;
  throw new Error('Invalid session registry turn status');
}

/** Whitelist for the `patch` payload. Every field a record can carry (minus identity) has a strict
 *  converter here; a key not listed is DROPPED on replay (the toOptionalBrowserValue trap, §8.1). */
const PATCH_FIELD_READERS: { [K in SessionPatchUnsetKey]: (value: unknown) => SessionRecord[K] } = {
  projectId: toStringValue,
  channel: toStringValue,
  backend: toStringValue,
  kind: toKindValue,
  origin: toOriginValue,
  createdAt: toStringValue,
  lastUsedAt: toStringValue,
  label: toNullableString,
  profileName: toNullableString,
  backendSessionId: toOptionalNullableString,
  lastReadAt: toOptionalNullableString,
  scheduleId: toOptionalNullableString,
  commissionId: toOptionalNullableString,
  commissionDraft: toOptionalNullableString,
  commissionBlockFor: toOptionalNullableString,
  contextUsage: value => value,
  browser: toOptionalBrowserValue,
};

/** Every key a `patch` may carry, derived from the exhaustive reader table so the WRITER (repo
 *  `diffRecord`) and the READER can never disagree: adding a field to SessionRecord without a
 *  reader is a compile error above, and the writer picks it up from here automatically. */
export const PATCH_KEYS = Object.keys(PATCH_FIELD_READERS) as SessionPatchUnsetKey[];
const PATCH_KEY_SET = new Set<string>(PATCH_KEYS);

function assertPatchFields(raw: unknown): SessionPatchFields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid session registry patch fields');
  const row = raw as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const reader = PATCH_FIELD_READERS[key as SessionPatchUnsetKey];
    if (!reader) throw new Error(`Unknown session registry patch field: ${key}`);
    fields[key] = reader(row[key]);
  }
  return fields as SessionPatchFields;
}

function assertTurnRecord(raw: unknown): TurnRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid session registry turn record');
  const row = raw as Record<string, unknown>;
  return {
    turnIndex: toNumberValue(row.turnIndex),
    userMessageTs: toStringValue(row.userMessageTs),
    userMessageText: toStringValue(row.userMessageText),
    statusMessageTs: toTurnNullableString(row.statusMessageTs),
    responseMessageTimestamps: toStringArray(row.responseMessageTimestamps),
    executionId: toTurnNullableString(row.executionId),
    backupPath: toTurnNullableString(row.backupPath),
    status: toTurnStatus(row.status),
    createdAt: toStringValue(row.createdAt),
    updatedAt: toStringValue(row.updatedAt),
  };
}

const TURN_FIELD_READERS: { [K in keyof TurnRecord]: (value: unknown) => TurnRecord[K] } = {
  turnIndex: toNumberValue,
  userMessageTs: toStringValue,
  userMessageText: toStringValue,
  statusMessageTs: toTurnNullableString,
  responseMessageTimestamps: toStringArray,
  executionId: toTurnNullableString,
  backupPath: toTurnNullableString,
  status: toTurnStatus,
  createdAt: toStringValue,
  updatedAt: toStringValue,
};

function assertPartialTurn(raw: unknown): Partial<TurnRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid session registry turn patch');
  const row = raw as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const reader = TURN_FIELD_READERS[key as keyof TurnRecord];
    if (!reader) throw new Error(`Unknown session registry turn field: ${key}`);
    fields[key] = reader(row[key]);
  }
  return fields as Partial<TurnRecord>;
}

/** Whitelist for the `conversation set` payload. A key not listed is DROPPED on replay (the same
 *  toOptionalBrowserValue trap that silently lost fields, §8.1) — keep in lock-step with the header. */
const CONVERSATION_FIELD_READERS: { [K in keyof ConversationHeader]: (value: unknown) => ConversationHeader[K] } = {
  sessionId: toTurnNullableString,
  sessionName: toTurnNullableString,
  backend: toStringValue,
  profileName: toTurnNullableString,
  updatedAt: toStringValue,
};

function assertConversationFields(raw: unknown): ConversationFields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid session registry conversation fields');
  const row = raw as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const reader = CONVERSATION_FIELD_READERS[key as keyof ConversationHeader];
    if (!reader) throw new Error(`Unknown session registry conversation field: ${key}`);
    fields[key] = reader(row[key]);
  }
  return fields as ConversationFields;
}

function assertAppendableEvent(state: SessionRegistryState, event: SessionRegistryEvent): void {
  if (event.op === 'put') assertPutAllowed(state, event.record);
  if (event.op === 'delete-intent') assertDeleteIntentAppendable(state, event.record);
  if (event.op === 'delete-commit') assertDeleteCommitAllowed(state, event.id);
  if (event.op === 'patch') assertPatchAppendable(state, event.id);
  // bind / turn / conversation carry no liveness guard: they are channel-scoped and may name a
  // session that is unknown, pending, or already gone (the free-map contract, §1).
}

function assertPatchAppendable(state: SessionRegistryState, sessionId: string): void {
  if (!state.live.has(sessionId)) throw new Error(`Patch for non-live session: ${sessionId}`);
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
  if (event.op === 'delete-commit') return applyDeleteCommit(state, event.id);
  if (event.op === 'patch') return applyPatch(state, event);
  if (event.op === 'bind') return applyBind(state, event.channel, event.sessionId);
  if (event.op === 'unbind') return applyUnbind(state, event.channel);
  if (event.op === 'conversation') return applyConversation(state, event);
  applyTurn(state, event);
}

/** Lenient replay: a patch whose session is no longer live (deleted later, or a torn compaction
 *  reorder) is skipped rather than thrown — the strict guard lives in the append path. */
function applyPatch(state: SessionRegistryState, event: Extract<SessionRegistryEvent, { op: 'patch' }>): void {
  const record = state.live.get(event.id);
  if (!record) return;
  const next = { ...record, ...event.fields } as Record<string, unknown>;
  for (const key of event.unset ?? []) delete next[key];
  state.live.set(event.id, next as unknown as SessionRecord);
}

/** Free-map bind: never gated on liveness — a channel may bind to an unknown, pending, or already
 *  committed session id, and it simply stays until unbind or delete-commit. */
function applyBind(state: SessionRegistryState, channel: string, sessionId: string): void {
  state.bindings.set(channel, sessionId);
}

function applyUnbind(state: SessionRegistryState, channel: string): void {
  state.bindings.delete(channel);
}

/** Channel-keyed turns: independent of the session record. `clear` drops the channel's list. */
function applyTurn(state: SessionRegistryState, event: Extract<SessionRegistryEvent, { op: 'turn' }>): void {
  const turns = state.turns.get(event.channel) ?? [];
  if (event.kind === 'begin') {
    turns.push(event.turn);
    state.turns.set(event.channel, turns);
  } else if (event.kind === 'patch') {
    const idx = turns.findIndex(turn => turn.turnIndex === event.turnIndex);
    if (idx >= 0) turns[idx] = { ...turns[idx], ...event.fields };
  } else if (event.kind === 'truncate') {
    state.turns.set(event.channel, turns.filter(turn => turn.turnIndex < event.fromIndex));
  } else {
    state.turns.delete(event.channel);
  }
}

/** Channel-keyed conversation header. `set` merges the payload onto the previous header (or onto a
 *  null base if the channel had none); `clear` drops the header. */
function applyConversation(state: SessionRegistryState, event: Extract<SessionRegistryEvent, { op: 'conversation' }>): void {
  if (event.kind === 'clear') {
    state.conversations.delete(event.channel);
    return;
  }
  const base: ConversationHeader = state.conversations.get(event.channel)
    ?? { sessionId: null, sessionName: null, backend: '', profileName: null, updatedAt: '' };
  state.conversations.set(event.channel, { ...base, ...event.fields });
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
  // A committed session keeps nothing on any channel bound to it: binding, turn history and the
  // conversation header are all dropped together (§1, §3). Unbind alone never touches turns/header.
  for (const [channel, boundId] of state.bindings) {
    if (boundId !== sessionId) continue;
    state.bindings.delete(channel);
    state.turns.delete(channel);
    state.conversations.delete(channel);
  }
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
