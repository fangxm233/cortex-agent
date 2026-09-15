// input:  the two flat legacy JSON stores under a store dir (sessions.json bindings +
//         conversation-ledger.json headers/turns) and SessionRegistryRepo
// output: importLegacySessionStores() — one-shot fold of the legacy stores into the JSONL session
//         registry (channel bindings + conversation headers + ordered turn history), then renames the
//         sources aside as `<file>.pre-<version>.bak`. Writes ONLY through the repo API so the journal
//         whitelist/replay contract stays the single source of truth for what a field means.
// pos:    Migration helper invoked as a step migration from store/version-migrations.ts (B.T4).
//         Idempotent via the rename: a second run finds no sources and is a no-op.
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '@core/log.js';
import { SessionRegistryRepo } from './session-registry-repo.js';
import type { ConversationFields, TurnRecord, TurnStatus } from './session-registry-journal.js';

const log = createLogger('session-registry-import');

const SESSIONS_FILE = 'sessions.json';
const LEDGER_FILE = 'conversation-ledger.json';
const REGISTRY_FILE = 'session-registry.jsonl';
const DEFAULT_VERSION = '2026.9.14';

export interface LegacyImportSummary {
  /** channel→sessionId bindings imported from sessions.json. */
  bindings: number;
  /** conversation headers imported from conversation-ledger.json. */
  conversations: number;
  /** total turns imported across all conversations. */
  turns: number;
  /** conversations whose header carried a non-null profileName. */
  profileNames: number;
  /** source basenames left in place because their JSON was corrupt. */
  skipped: string[];
  /** `.bak` basenames the sources were renamed to. */
  renamed: string[];
}

type LegacyRead =
  | { kind: 'ok'; data: unknown }
  | { kind: 'missing' }
  | { kind: 'corrupt'; message: string };

interface LegacyConversation {
  channel: string;
  header: ConversationFields;
  turns: TurnRecord[];
  hasProfileName: boolean;
}

/**
 * Fold `<storeDir>/sessions.json` (bindings) and `<storeDir>/conversation-ledger.json` (headers +
 * turns) into `<storeDir>/session-registry.jsonl` via the repo API, then rename each successfully
 * consumed source to `<file>.pre-<version>.bak`.
 *
 * Semantics:
 *  - A missing source contributes 0 counts and is not renamed.
 *  - A corrupt source (unparseable JSON) is logged, listed in `skipped`, and LEFT ON DISK for manual
 *    inspection; the other source is still imported and the migration still succeeds (the caller
 *    bumps its version). Re-importing the good source on a retry is harmless: the good source has
 *    already been renamed away, so the retry sees it as missing.
 *  - Bindings whose session id is absent from the registry are imported anyway (bind is a free map).
 *  - Idempotent: after the rename, a second run finds no sources and does nothing (no journal growth).
 *  - Crash-safe: on a crash between the journal appends and the renames the sources are still present,
 *    so the next boot re-imports; per-channel turns are cleared before re-appending (only when the
 *    channel already carries turns), so the imported state converges rather than duplicating turns.
 */
export async function importLegacySessionStores(
  storeDir: string,
  opts: { version?: string } = {},
): Promise<LegacyImportSummary> {
  const version = opts.version ?? DEFAULT_VERSION;
  const summary: LegacyImportSummary = {
    bindings: 0, conversations: 0, turns: 0, profileNames: 0, skipped: [], renamed: [],
  };

  const sessionsRead = await readLegacyStore(path.join(storeDir, SESSIONS_FILE));
  const ledgerRead = await readLegacyStore(path.join(storeDir, LEDGER_FILE));

  if (sessionsRead.kind === 'corrupt') {
    log.warn(`Corrupt ${SESSIONS_FILE} (${sessionsRead.message}); leaving it in place and skipping its bindings`);
    summary.skipped.push(SESSIONS_FILE);
  }
  if (ledgerRead.kind === 'corrupt') {
    log.warn(`Corrupt ${LEDGER_FILE} (${ledgerRead.message}); leaving it in place and skipping its conversations`);
    summary.skipped.push(LEDGER_FILE);
  }

  const bindings = sessionsRead.kind === 'ok' ? parseBindings(sessionsRead.data) : [];
  const conversations = ledgerRead.kind === 'ok' ? parseConversations(ledgerRead.data) : [];

  if (bindings.length > 0 || conversations.length > 0) {
    const repo = new SessionRegistryRepo(path.join(storeDir, REGISTRY_FILE));
    // One admission lock for the whole import: every bind/header/turn lands before we rename the
    // sources, so a reader that opens the journal after the rename sees the complete import.
    await repo.batch(async (ops) => {
      for (const [channel, sessionId] of bindings) {
        await ops.bindChannel(channel, sessionId);
        summary.bindings += 1;
      }
      for (const conv of conversations) {
        await ops.setConversation(conv.channel, conv.header);
        summary.conversations += 1;
        if (conv.hasProfileName) summary.profileNames += 1;
        // Clear only when the channel already has turns — a crashed prior import may have left a
        // partial list. On the clean first run channels have none, so no redundant clear is written.
        if (ops.getTurns(conv.channel).length > 0) await ops.clearTurns(conv.channel);
        for (const turn of conv.turns) {
          await ops.beginTurn(conv.channel, turn);
          summary.turns += 1;
        }
      }
    });
  }

  // Rename only sources we actually consumed (present + parseable). A corrupt or missing source is
  // left untouched. Deterministic name keyed off the migration version so retries are predictable.
  if (sessionsRead.kind === 'ok') await renameSource(storeDir, SESSIONS_FILE, version, summary);
  if (ledgerRead.kind === 'ok') await renameSource(storeDir, LEDGER_FILE, version, summary);

  return summary;
}

async function readLegacyStore(filePath: string): Promise<LegacyRead> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  try {
    return { kind: 'ok', data: JSON.parse(raw) };
  } catch (err) {
    return { kind: 'corrupt', message: (err as Error).message };
  }
}

/** sessions.json is a flat `{ "<channel>": "<sessionId>" }`. Keys are literal channel strings and
 *  are imported verbatim; entries whose channel or session id is not a non-empty string are dropped
 *  (an empty id would make the bind line unreadable on replay). */
function parseBindings(data: unknown): Array<[string, string]> {
  if (!isPlainObject(data)) return [];
  const out: Array<[string, string]> = [];
  for (const [channel, sessionId] of Object.entries(data)) {
    if (channel && typeof sessionId === 'string' && sessionId) out.push([channel, sessionId]);
  }
  return out;
}

/** conversation-ledger.json is a flat `{ "<channel>": { sessionId, sessionName, backend, profileName,
 *  turns[], updatedAt } }`. Every header field (including `sessionId: null`) and the source
 *  `updatedAt` are preserved; turns keep their order and indices. */
function parseConversations(data: unknown): LegacyConversation[] {
  if (!isPlainObject(data)) return [];
  const out: LegacyConversation[] = [];
  for (const [channel, value] of Object.entries(data)) {
    if (!channel || !isPlainObject(value)) continue;
    const header: ConversationFields = {
      sessionId: headerString(value.sessionId),
      sessionName: headerString(value.sessionName),
      backend: typeof value.backend === 'string' ? value.backend : '',
      profileName: headerString(value.profileName),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    };
    const turns = Array.isArray(value.turns) ? value.turns.filter(isPlainObject).map(toTurnRecord) : [];
    out.push({
      channel,
      header,
      turns,
      hasProfileName: typeof value.profileName === 'string' && value.profileName.length > 0,
    });
  }
  return out;
}

/** Preserve the header string EXACTLY as the ledger stored it: `null` stays null, a string (incl. the
 *  empty string) stays a string. Mirrors the journal's `toTurnNullableString` reader so the value
 *  survives replay unchanged; anything else collapses to null. */
function headerString(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : null;
}

function toTurnRecord(value: Record<string, unknown>): TurnRecord {
  return {
    turnIndex: typeof value.turnIndex === 'number' ? value.turnIndex : Number(value.turnIndex),
    userMessageTs: asString(value.userMessageTs),
    userMessageText: asString(value.userMessageText),
    statusMessageTs: asNullableString(value.statusMessageTs),
    responseMessageTimestamps: Array.isArray(value.responseMessageTimestamps)
      ? value.responseMessageTimestamps.map((t) => String(t))
      : [],
    executionId: asNullableString(value.executionId),
    backupPath: asNullableString(value.backupPath),
    status: value.status as TurnStatus,
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function renameSource(
  dir: string,
  file: string,
  version: string,
  summary: LegacyImportSummary,
): Promise<void> {
  const target = `${file}.pre-${version}.bak`;
  await fs.rename(path.join(dir, file), path.join(dir, target));
  summary.renamed.push(target);
}
