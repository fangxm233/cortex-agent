import { beforeAll, afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SessionRegistryRepo, effectiveBackendSessionId, sessionStore } from '../../src/store/session-registry-repo.js';
import { ConversationLedgerRepo, conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { seedTestModels, TEST_CLAUDE_SELECTION, TEST_PI_SELECTION } from '../_seed-models.js';
import type { EngineSelection } from '../../src/domain/agents/engine-selection.js';
import { setSessionAsync } from '../../src/domain/sessions/session.js';
import {
  getChannelSelection,
  setChannelSelection,
  applyChannelSelection,
} from '../../src/domain/agents/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// B.T0 — golden characterization tests for session identity.
//
// These goldens pin session-identity BEHAVIOUR through PUBLIC READ APIs and
// observable effects only — never through file bytes, file names, or on-disk
// layout. The next tasks fold sessions.json (channel→sessionId) and
// conversation-ledger.json (per-channel header + turns) into the registry
// journal as events; sessionRepo disappears and conversationLedger becomes a
// façade. The disk layout WILL change, so a golden that read file bytes would
// break for the wrong reason. Every snapshot below is built from read APIs:
//   sessionRepo.getSessionAsync(channel)               — the channel→session binding
//   sessionStore.getById — the record
//   conversationLedger.getConversation / findTurn      — header + turns
//   sessionStore.getBoundSessionId / listRecentSessions
//
// Timestamps are minted internally by the stores (new Date().toISOString()).
// Consecutive store mutations frequently land in the SAME millisecond on a fast
// machine (the JsonRepository write is faster than the clock's ms tick), so the
// NUMBER of distinct timestamps in a sequence is not stable run to run — a
// first-seen <t1>/<t2>/… numbering would flake. Every golden therefore collapses
// every ISO timestamp to a single <ts> token: presence vs null is still pinned,
// but the exact value and inter-timestamp ordering are deliberately not. The
// normaliser also DROPS keys whose value is undefined so that a live record and
// the same record replayed from the journal (which serialises undefined away)
// compare equal — an on-disk-shape difference, not a behavioural one. An unset
// binding (getSessionAsync → undefined) is captured as the sentinel '<unbound>'
// so its absence stays visible after the undefined-drop. Dynamically generated
// names/ids are normalised via an explicit substitution list; everywhere else
// this file uses deterministic ids so the snapshots stay stable.
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir = '';
let testId = 0;
const FAST_SELECTION: EngineSelection = { ...TEST_CLAUDE_SELECTION, model: 'claude-haiku-4-5' };
const REVIEW_SELECTION: EngineSelection = { ...TEST_CLAUDE_SELECTION, thinking: 'high', mode: 'api' };

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-identity-golden-'));
  seedTestModels();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A fresh, fully-isolated store backed by its own temp journal. After B.T2 there is ONE store — the
// session registry — that owns channel bindings, conversation headers and turns. `ledger` is the
// façade over that same registry.
function freshStores() {
  const id = testId++;
  const registry = new SessionRegistryRepo(path.join(tmpDir, `reg-${id}.jsonl`));
  return {
    registry,
    ledger: new ConversationLedgerRepo(registry),
  };
}

// Stable replacer: literal substitutions (ordered longest-first by the caller),
// every ISO timestamp → the single token '<ts>', and every undefined-valued
// object key dropped.
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
function normalize<T>(value: T, subs: Array<[string, string]> = []): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let s = v;
      for (const [from, to] of subs) if (from) s = s.split(from).join(to);
      return s.replace(ISO_RE, '<ts>');
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        const nv = (v as Record<string, unknown>)[k];
        if (nv === undefined) continue; // treat "key present = undefined" as absent
        out[k] = walk(nv);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

// ── 5. Turn lifecycle: initAndBeginTurn(anchor) → addResponseTs×2 → completeTurn → 2nd turn ──
test('golden 5: turn lifecycle records the turn verbatim (text, response ts, status, exec id, anchor)', async () => {
  const { ledger } = freshStores();
  const channel = 'web:g5-channel';
  const userText1 = 'first user message\nwith a newline and unicode ☃ kept verbatim';

  await ledger.initAndBeginTurn(channel, {
    sessionId: 'sid-5', backend: 'claude', selection: TEST_CLAUDE_SELECTION,
    userMessageTs: 'u-msg-1', userMessageText: userText1, statusMessageTs: 'status-1',
    anchor: { file: '/sessions/backend-5.jsonl', after: 'e-41' },
  });
  await ledger.addResponseTs(channel, 'u-msg-1', 'resp-1a');
  await ledger.addResponseTs(channel, 'u-msg-1', 'resp-1b');
  await ledger.completeTurn(channel, 'u-msg-1', { executionId: 'exec-1' });
  await ledger.beginTurn(channel, { userMessageTs: 'u-msg-2', userMessageText: 'second message text' });

  assert.deepEqual(normalize(await ledger.getConversation(channel)), {
    sessionId: 'sid-5',
    backend: 'claude',
    selection: TEST_CLAUDE_SELECTION,
    turns: [
      {
        turnIndex: 0,
        userMessageTs: 'u-msg-1',
        userMessageText: 'first user message\nwith a newline and unicode ☃ kept verbatim',
        statusMessageTs: 'status-1',
        responseMessageTimestamps: ['resp-1a', 'resp-1b'],
        executionId: 'exec-1',
        backupPath: null,
        anchor: { file: '/sessions/backend-5.jsonl', after: 'e-41' },
        status: 'completed',
        createdAt: '<ts>',
        updatedAt: '<ts>',
      },
      {
        turnIndex: 1,
        userMessageTs: 'u-msg-2',
        userMessageText: 'second message text',
        statusMessageTs: null,
        responseMessageTimestamps: [],
        executionId: null,
        backupPath: null,
        status: 'processing',
        createdAt: '<ts>',
        updatedAt: '<ts>',
      },
    ],
    updatedAt: '<ts>',
  });
});

// ── 6. rollbackTo + truncateTurns after three turns (the rewind path) ──
test('golden 6: rollbackTo marks superseded and truncateTurns rewinds the conversation', async () => {
  const { ledger } = freshStores();
  const channel = 'web:g6-channel';

  await ledger.initAndBeginTurn(channel, {
    sessionId: 'sid-6', backend: 'claude',
    userMessageTs: 'u1', userMessageText: 'turn one', statusMessageTs: 's1',
  });
  await ledger.completeTurn(channel, 'u1');
  await ledger.beginTurn(channel, { userMessageTs: 'u2', userMessageText: 'turn two' });
  await ledger.completeTurn(channel, 'u2');
  await ledger.beginTurn(channel, { userMessageTs: 'u3', userMessageText: 'turn three' });

  const rollback = await ledger.rollbackTo(channel, 1);
  await ledger.truncateTurns(channel, 1);

  const snapshot = {
    supersededTurns: rollback?.supersededTurns,
    conversationAfter: await ledger.getConversation(channel),
  };

  assert.deepEqual(normalize(snapshot), {
    supersededTurns: [
      {
        turnIndex: 1,
        userMessageTs: 'u2',
        userMessageText: 'turn two',
        statusMessageTs: null,
        responseMessageTimestamps: [],
        executionId: null,
        backupPath: null,
        status: 'superseded',
        createdAt: '<ts>',
        updatedAt: '<ts>',
      },
      {
        turnIndex: 2,
        userMessageTs: 'u3',
        userMessageText: 'turn three',
        statusMessageTs: null,
        responseMessageTimestamps: [],
        executionId: null,
        backupPath: null,
        status: 'superseded',
        createdAt: '<ts>',
        updatedAt: '<ts>',
      },
    ],
    conversationAfter: {
      sessionId: 'sid-6',
      backend: 'claude',
      selection: null,
      turns: [
        {
          turnIndex: 0,
          userMessageTs: 'u1',
          userMessageText: 'turn one',
          statusMessageTs: 's1',
          responseMessageTimestamps: [],
          executionId: null,
          backupPath: null,
          status: 'completed',
          createdAt: '<ts>',
          updatedAt: '<ts>',
        },
      ],
      updatedAt: '<ts>', // truncateTurns bumped conv.updatedAt (a fresh timestamp; all collapse to <ts>)
    },
  });
});

// ── 7. updateSessionId on a conversation whose sessionId is null (the late bind, terminal.ts:211-212) ──
test('golden 7: updateSessionId late-binds a null-session conversation', async () => {
  const { ledger } = freshStores();
  const channel = 'web:g7-channel';

  await ledger.initConversation(channel, {
    sessionId: null, backend: 'claude',
  });
  await ledger.updateSessionId(channel, 'sid-late-7');

  assert.deepEqual(normalize(await ledger.getConversation(channel)), {
    sessionId: 'sid-late-7',
    backend: 'claude',
    selection: null,
    turns: [],
    updatedAt: '<ts>',
  });
});

// ── 8. switchSession on a channel with existing turns — turns reset, header replaced ──
test('golden 8: switchSession replaces the header and resets turns', async () => {
  const { ledger } = freshStores();
  const channel = 'web:g8-channel';

  await ledger.initConversation(channel, {
    sessionId: 'sid-8a', backend: 'claude', selection: TEST_CLAUDE_SELECTION,
  });
  await ledger.beginTurn(channel, { userMessageTs: 'u1', userMessageText: 'old turn' });

  await ledger.switchSession(channel, {
    sessionId: 'sid-8b', backend: 'claude', selection: FAST_SELECTION,
  });

  assert.deepEqual(normalize(await ledger.getConversation(channel)), {
    sessionId: 'sid-8b',
    backend: 'claude',
    selection: FAST_SELECTION,
    turns: [],
    updatedAt: '<ts>',
  });
});

async function bindSelectionSession(channel: string, sessionId: string): Promise<void> {
  setChannelSelection(channel, TEST_CLAUDE_SELECTION);
  await sessionStore.registerSession({
    sessionId, channel, backend: 'claude', kind: 'local', projectId: 'projX', selection: TEST_CLAUDE_SELECTION,
  });
  await setSessionAsync(channel, sessionId);
  await conversationLedger.initConversation(channel, {
    sessionId, backend: 'claude', selection: TEST_CLAUDE_SELECTION,
  });
}

// Route validation is independent of any gateway configuration seeded by the test harness.
function select(channel: string, selection: EngineSelection) {
  return applyChannelSelection({ channel, ...selection, readGateway: () => null });
}

async function assertSelected(channel: string, sessionId: string, selection: EngineSelection): Promise<void> {
  assert.equal(await sessionStore.getBoundSessionId(channel), sessionId);
  const record = await sessionStore.getById(sessionId);
  assert.equal(record?.sessionId, sessionId);
  assert.deepEqual(record?.selection, selection);
  assert.deepEqual(getChannelSelection(channel), selection);
}

test('golden 10: selection writer syncs the bound record and refuses cross-backend with turns', async () => {
  const channel = 'slack:g10-channel';
  const sid = 'sid-10';
  await bindSelectionSession(channel, sid);
  assert.equal((await sessionStore.getTurns(channel)).length, 0);
  await assertSelected(channel, sid, TEST_CLAUDE_SELECTION);
  assert.deepEqual(await select(channel, FAST_SELECTION), { ...FAST_SELECTION, ok: true, backendChanged: false });
  await assertSelected(channel, sid, FAST_SELECTION);
  await conversationLedger.beginTurn(channel, { userMessageTs: 'u1', userMessageText: 'now live' });
  assert.equal((await sessionStore.getTurns(channel)).length, 1);
  assert.deepEqual(await select(channel, TEST_PI_SELECTION), {
    ...FAST_SELECTION, ok: false, backendChanged: false, reason: 'cross-backend-live-session',
    currentBackend: 'claude', targetBackend: 'pi',
  });
  await assertSelected(channel, sid, FAST_SELECTION);
  assert.deepEqual(await select(channel, REVIEW_SELECTION), { ...REVIEW_SELECTION, ok: true, backendChanged: false });
  await assertSelected(channel, sid, REVIEW_SELECTION);
  assert.equal((await conversationLedger.findTurn(channel, 'u1'))?.turn.userMessageText, 'now live');
});

test('golden 10b: backend picks are channel-local and keep a fresh session identity stable', async () => {
  const channel = 'slack:g10b-channel';
  const other = 'slack:g10b-other';
  await bindSelectionSession(channel, 'sid-10b');
  await bindSelectionSession(other, 'sid-10b-other');
  await conversationLedger.beginTurn(other, { userMessageTs: 'other-u1', userMessageText: 'other history' });
  assert.deepEqual(await select(channel, TEST_PI_SELECTION), { ...TEST_PI_SELECTION, ok: true, backendChanged: true });
  await assertSelected(channel, 'sid-10b', TEST_PI_SELECTION);
  await assertSelected(other, 'sid-10b-other', TEST_CLAUDE_SELECTION);
  assert.equal(effectiveBackendSessionId((await sessionStore.getById('sid-10b'))!), null);
  assert.equal((await conversationLedger.getConversation(channel))?.sessionId, 'sid-10b');
  assert.equal((await conversationLedger.findTurn(other, 'other-u1'))?.turn.userMessageText, 'other history');
});

test('golden 10c: a resumed backend id blocks a backend change even without channel turns', async () => {
  const channel = 'slack:g10c-channel';
  await bindSelectionSession(channel, 'sid-10c');
  await sessionStore.updateSession('sid-10c', { backendSessionId: 'backend-10c' });
  assert.equal((await sessionStore.getTurns(channel)).length, 0);
  assert.deepEqual(await select(channel, TEST_PI_SELECTION), {
    ...TEST_CLAUDE_SELECTION, ok: false, backendChanged: false, reason: 'cross-backend-live-session',
    currentBackend: 'claude', targetBackend: 'pi',
  });
  await assertSelected(channel, 'sid-10c', TEST_CLAUDE_SELECTION);
  assert.equal(effectiveBackendSessionId((await sessionStore.getById('sid-10c'))!), 'backend-10c');
});

// Ledger headers never write through to the authoritative session-record selection.
test('golden 11: session-record selection is isolated from ledger conversation headers', async () => {
  const { registry, ledger } = freshStores();
  const recordSelection = async (sessionId: string) => (await registry.getById(sessionId))?.selection ?? null;
  await registry.registerSession({
    sessionId: 'sid-11a', channel: 'web:11a', backend: 'claude', kind: 'local', projectId: 'projX', selection: TEST_CLAUDE_SELECTION,
  });
  await ledger.initConversation('web:11a', { sessionId: 'sid-11a', backend: 'claude', selection: REVIEW_SELECTION });
  await registry.registerSession({
    sessionId: 'sid-11b', channel: 'web:11b', backend: 'claude', kind: 'local', projectId: 'projX', selection: null,
  });
  await ledger.initConversation('web:11b', { sessionId: 'sid-11b', backend: 'claude', selection: FAST_SELECTION });
  assert.deepEqual({
    a_registryWins: await recordSelection('sid-11a'),
    b_ledgerFallback: await recordSelection('sid-11b'),
    c_neither: await recordSelection('sid-11c'),
  }, {
    a_registryWins: TEST_CLAUDE_SELECTION,
    b_ledgerFallback: null,
    c_neither: null,
  });
});
