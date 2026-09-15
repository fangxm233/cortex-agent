import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { importLegacySessionStores } from '../../src/store/session-registry-import.js';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';
import type { TurnRecord } from '../../src/store/session-registry-journal.js';

const VERSION = '2026.9.14';

let storeDir: string;

beforeEach(async () => {
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-import-'));
});

afterEach(async () => {
  await fs.rm(storeDir, { recursive: true, force: true });
});

// ── Fixture builder (real-data scale) ──────────────────────────

interface LegacyHeader {
  sessionId: string | null;
  sessionName: string | null;
  backend: string;
  profileName: string | null;
  turns: TurnRecord[];
  updatedAt: string;
}

function turn(channel: string, i: number): TurnRecord {
  return {
    turnIndex: i,
    userMessageTs: `${channel}_ts_${i}`,
    userMessageText: `msg ${i} on ${channel}`,
    // Alternate null / empty-string / value to exercise the nullable-string whitelist readers.
    statusMessageTs: i % 3 === 0 ? null : i % 3 === 1 ? '' : `status_${i}`,
    responseMessageTimestamps: i % 2 === 0 ? [] : [`r_${i}_a`, `r_${i}_b`],
    executionId: i % 4 === 0 ? null : `exec_${channel}_${i}`,
    backupPath: i % 5 === 0 ? null : `/backups/${channel}/${i}.bak`,
    status: i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'processing' : 'superseded',
    createdAt: `2026-09-12T20:${String(i % 60).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-09-12T20:${String(i % 60).padStart(2, '0')}:30.000Z`,
  };
}

/** 80 channels across web:/slack:/tui-/legacy claude:slack: keys; ~300 turns; one profileName; several
 *  sessionId:null headers. Returns the raw legacy stores plus the expected reads. */
function buildFixture(): {
  sessions: Record<string, string>;
  ledger: Record<string, LegacyHeader>;
  ledgerOnlyChannel: string;
  bindingOnlyChannel: string;
  totalTurns: number;
} {
  const channels: string[] = [];
  for (let i = 0; i < 20; i++) channels.push(`web:${i.toString(16).padStart(8, '0')}-uuid`);
  for (let i = 0; i < 20; i++) channels.push(`slack:C${1000 + i}`);
  for (let i = 0; i < 20; i++) channels.push(`tui-${i}`);
  for (let i = 0; i < 20; i++) channels.push(`claude:slack:C${2000 + i}`); // legacy literal key

  const ledger: Record<string, LegacyHeader> = {};
  const sessions: Record<string, string> = {};
  let totalTurns = 0;

  // One channel present in the ledger but NOT in sessions.json (and vice versa).
  const ledgerOnlyChannel = channels[7];
  const bindingOnlyChannel = 'web:orphan-binding-uuid';

  channels.forEach((channel, i) => {
    const nTurns = (i % 7) + 1; // 1..7
    const turns = Array.from({ length: nTurns }, (_, k) => turn(channel, k));
    totalTurns += nTurns;
    ledger[channel] = {
      sessionId: i % 11 === 0 ? null : `sess-${i}`, // several sessionId:null headers
      sessionName: i % 13 === 0 ? null : `cortex-${i.toString(16)}`,
      backend: i % 2 === 0 ? 'pi' : 'claude',
      profileName: i === 5 ? 'plan' : null, // exactly one non-null profileName
      turns,
      updatedAt: `2026-09-12T21:${String(i % 60).padStart(2, '0')}:00.000Z`,
    };
    // Bind every ledger channel except the ledger-only one; sessionIds are all UNKNOWN to the
    // registry (never registered as puts) — the free-map bind must accept them anyway.
    if (channel !== ledgerOnlyChannel) sessions[channel] = `bound-${i}`;
  });

  // A binding whose channel has no ledger entry at all.
  sessions[bindingOnlyChannel] = 'bound-orphan';

  return { sessions, ledger, ledgerOnlyChannel, bindingOnlyChannel, totalTurns };
}

async function writeStores(sessions: unknown, ledger: unknown): Promise<void> {
  await fs.writeFile(path.join(storeDir, 'sessions.json'), JSON.stringify(sessions, null, 2));
  await fs.writeFile(path.join(storeDir, 'conversation-ledger.json'), JSON.stringify(ledger, null, 2));
}

/** Seed the journal with a few unrelated `put` records so the import runs against a non-empty file. */
async function seedExistingJournal(): Promise<string[]> {
  const repo = new SessionRegistryRepo(path.join(storeDir, 'session-registry.jsonl'));
  const names: string[] = [];
  for (let i = 0; i < 3; i++) {
    const name = `seed-${i}`;
    names.push(name);
    await repo.registerSession(name, {
      sessionId: `seed-session-${i}`,
      channel: `seed-channel-${i}`,
      backend: 'pi',
      kind: 'local',
    });
  }
  await repo.flush();
  return names;
}

function freshRepo(): SessionRegistryRepo {
  return new SessionRegistryRepo(path.join(storeDir, 'session-registry.jsonl'));
}

async function journalLineCount(): Promise<number> {
  const raw = await fs.readFile(path.join(storeDir, 'session-registry.jsonl'), 'utf8');
  return raw.split('\n').filter((l) => l.length > 0).length;
}

// ── Tests ──────────────────────────────────────────────────────

test('imports bindings, headers and turns; every field survives a reload', async () => {
  const fx = buildFixture();
  const seededNames = await seedExistingJournal();
  await writeStores(fx.sessions, fx.ledger);

  const sessionsBytes = await fs.readFile(path.join(storeDir, 'sessions.json'));
  const ledgerBytes = await fs.readFile(path.join(storeDir, 'conversation-ledger.json'));

  const summary = await importLegacySessionStores(storeDir, { version: VERSION });

  // Summary counts match the fixture exactly.
  assert.equal(summary.bindings, Object.keys(fx.sessions).length);
  assert.equal(summary.conversations, Object.keys(fx.ledger).length);
  assert.equal(summary.turns, fx.totalTurns);
  assert.equal(summary.profileNames, 1);
  assert.deepEqual(summary.skipped, []);
  assert.deepEqual(
    summary.renamed.sort(),
    [`conversation-ledger.json.pre-${VERSION}.bak`, `sessions.json.pre-${VERSION}.bak`],
  );

  // Read back through a FRESH repo so everything is replayed from disk (catches the whitelist trap).
  const repo = freshRepo();

  // Every source binding resolves to the same session id.
  for (const [channel, sessionId] of Object.entries(fx.sessions)) {
    assert.equal(await repo.getBoundSessionId(channel), sessionId, `binding for ${channel}`);
  }

  // Every header field round-trips, and turns match per-channel field-by-field.
  for (const [channel, header] of Object.entries(fx.ledger)) {
    const conv = await repo.readConversation(channel);
    assert.ok(conv, `conversation for ${channel}`);
    assert.equal(conv.header.sessionId, header.sessionId);
    assert.equal(conv.header.sessionName, header.sessionName);
    assert.equal(conv.header.backend, header.backend);
    assert.equal(conv.header.profileName, header.profileName);
    assert.equal(conv.header.updatedAt, header.updatedAt);
    assert.deepEqual(await repo.getTurns(channel), header.turns, `turns for ${channel}`);
  }

  // Header count via listConversations.
  const all = await repo.listConversations();
  assert.equal(all.length, Object.keys(fx.ledger).length);

  // The ledger-only channel has a header but no binding; the binding-only channel binds but has no
  // header.
  assert.equal(await repo.getBoundSessionId(fx.ledgerOnlyChannel), null);
  assert.equal(await repo.readConversation(fx.bindingOnlyChannel), null);
  assert.equal(await repo.getBoundSessionId(fx.bindingOnlyChannel), 'bound-orphan');

  // Pre-existing put records are untouched.
  for (const name of seededNames) {
    assert.ok(await repo.lookupSession(name), `seeded session ${name} survived`);
  }

  // .bak files hold the original bytes; sources are gone.
  assert.deepEqual(await fs.readFile(path.join(storeDir, `sessions.json.pre-${VERSION}.bak`)), sessionsBytes);
  assert.deepEqual(await fs.readFile(path.join(storeDir, `conversation-ledger.json.pre-${VERSION}.bak`)), ledgerBytes);
  assert.equal(await exists(path.join(storeDir, 'sessions.json')), false);
  assert.equal(await exists(path.join(storeDir, 'conversation-ledger.json')), false);
});

test('rerun after import is a no-op (journal line count unchanged, zero summary)', async () => {
  const fx = buildFixture();
  await writeStores(fx.sessions, fx.ledger);

  await importLegacySessionStores(storeDir, { version: VERSION });
  const linesAfterFirst = await journalLineCount();

  const second = await importLegacySessionStores(storeDir, { version: VERSION });
  assert.deepEqual(second, {
    bindings: 0, conversations: 0, turns: 0, profileNames: 0, skipped: [], renamed: [],
  });
  assert.equal(await journalLineCount(), linesAfterFirst, 'second run must not grow the journal');
});

test('missing sources produce a zero summary and no rename', async () => {
  // storeDir is empty — neither sessions.json nor conversation-ledger.json exists.
  const summary = await importLegacySessionStores(storeDir, { version: VERSION });
  assert.deepEqual(summary, {
    bindings: 0, conversations: 0, turns: 0, profileNames: 0, skipped: [], renamed: [],
  });
  // No .bak files created.
  assert.equal(await exists(path.join(storeDir, `sessions.json.pre-${VERSION}.bak`)), false);
});

test('corrupt ledger: bindings still import, ledger is left on disk, sessions.json renamed', async () => {
  const fx = buildFixture();
  await fs.writeFile(path.join(storeDir, 'sessions.json'), JSON.stringify(fx.sessions, null, 2));
  await fs.writeFile(path.join(storeDir, 'conversation-ledger.json'), 'not valid json {');

  const summary = await importLegacySessionStores(storeDir, { version: VERSION });

  assert.equal(summary.bindings, Object.keys(fx.sessions).length);
  assert.equal(summary.conversations, 0);
  assert.equal(summary.turns, 0);
  assert.deepEqual(summary.skipped, ['conversation-ledger.json']);
  assert.deepEqual(summary.renamed, [`sessions.json.pre-${VERSION}.bak`]);

  // The corrupt ledger is untouched for manual inspection; sessions.json is renamed away.
  assert.equal(await exists(path.join(storeDir, 'conversation-ledger.json')), true);
  assert.equal(await exists(path.join(storeDir, 'sessions.json')), false);

  // Bindings resolve on a fresh repo.
  const repo = freshRepo();
  for (const [channel, sessionId] of Object.entries(fx.sessions)) {
    assert.equal(await repo.getBoundSessionId(channel), sessionId);
  }
});

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
