import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { beforeAll, afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SessionRegistryRepo, effectiveBackendSessionId, sessionStore } from '../../src/store/session-registry-repo.js';
import { ConversationLedgerRepo, conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { profileRepo } from '../../src/store/profile-repo.js';
import {
  createDirectSession,
  attachExistingSession,
  adoptScheduledSession,
  resetChannelSession,
} from '../../src/domain/sessions/session-lifecycle.js';
import { resolveOnNewProfileName } from '../../src/domain/sessions/session-hooks.js';
import { registerThreadSession } from '../../src/domain/scheduling/jobs/register-thread-session.js';
import { setSessionAsync, getSessionAsync } from '../../src/domain/sessions/session.js';
import {
  getActiveProfile,
  setActiveProfile,
  switchChannelProfile,
  channelHasHistory,
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
//   sessionStore.lookupBySessionId / getById / lookupSession — the record
//   conversationLedger.getConversation / findTurn      — header + turns
//   sessionStore.getActiveSessionName / listRecentSessions
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

const HOME = process.env.CORTEX_HOME!;
const PROFILES = path.join(HOME, 'config', 'profiles.json');

// Same minimal profile set the run-tests.sh harness seeds. Written here too so
// the file also passes under `pnpm test:file` (which does NOT run through
// run-tests.sh and therefore leaves the isolated home without a profiles.json).
// `plan`/`scan`/`qa` share backend claude; `execute` is pi — used to pin the
// cross-backend switch rejection.
const PROFILES_FILE = {
  defaultProfile: 'plan',
  profiles: {
    plan: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
    scan: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
    qa: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
    execute: { model: 'claude-sonnet-4-6', backend: 'pi', provider: 'anthropic', mode: 'plan' },
  },
};

let tmpDir = '';
let testId = 0;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-identity-golden-'));
  await fs.mkdir(path.dirname(PROFILES), { recursive: true });
  await fs.writeFile(PROFILES, JSON.stringify(PROFILES_FILE));
  profileRepo.invalidate();
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A fresh, fully-isolated store backed by its own temp journal. After B.T2 there is ONE store — the
// session registry — that owns channel bindings, conversation headers and turns. `sessions` is a thin
// adapter that re-exposes the old sessions.json surface (setSessionAsync/getSessionAsync/
// deleteManyBySessionIds/registerConduitResolver) as registry calls, so the goldens keep compiling
// while proving behaviour through the same read APIs. `ledger` is the façade over that same registry.
function freshStores() {
  const id = testId++;
  const registry = new SessionRegistryRepo(path.join(tmpDir, `reg-${id}.jsonl`));
  const sessions = {
    setSessionAsync: (channel: string, sessionId: string, _backend?: string) =>
      registry.bindChannel(channel, sessionId),
    getSessionAsync: async (channel: string, _backend?: string): Promise<string | undefined> =>
      (await registry.getBoundSessionId(channel)) ?? undefined,
    deleteManyBySessionIds: (sessionIds: Iterable<string>) => registry.unbindBySessionIds(sessionIds),
    registerConduitResolver: (fn: (channel: string) => string | null | undefined) =>
      registry.registerConduitResolver(fn),
  };
  return {
    registry,
    sessions,
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

// ── 1. createDirectSession: registerNamedSession(put) + setChannelSession(bind) + initConversation ──
test('golden 1: createDirectSession binds channel, registers record, and inits conversation', async () => {
  const { registry, sessions, ledger } = freshStores();
  const sid = 'sid-1';
  const channel = `web:${sid}`;

  const res = await createDirectSession(
    {
      sessionStore: registry,
      setChannelSession: (ch, id, backend) => sessions.setSessionAsync(ch, id, backend),
      initConversation: (ch, opts) => ledger.initConversation(ch, opts).then(() => undefined),
      resolveBackend: () => 'claude',
    },
    { projectId: 'projX', sessionId: sid },
  );

  const snapshot = {
    returnedChannel: res.channel,
    binding: await sessions.getSessionAsync(channel),
    lookupBySessionId: await registry.lookupBySessionId(sid),
    record: await registry.getById(sid),
    conversation: await ledger.getConversation(channel),
  };

  // generateSessionName mints a random cortex-XXXXXX; normalise it to <name>.
  assert.deepEqual(normalize(snapshot, [[res.sessionName, '<name>']]), {
    returnedChannel: 'web:sid-1',
    binding: 'sid-1',
    lookupBySessionId: '<name>',
    record: {
      name: '<name>',
      sessionId: 'sid-1',
      projectId: 'projX',
      channel: 'web:sid-1',
      backend: 'claude',
      kind: 'local',
      origin: 'direct',
      createdAt: '<ts>',
      lastUsedAt: '<ts>',
      label: null,
      profileName: null,
      backendSessionId: null,
      scheduleId: null,
      browser: null,
      commissionId: null,
      commissionDraft: null,
    },
    conversation: {
      sessionId: 'sid-1',
      sessionName: '<name>',
      backend: 'claude',
      profileName: null,
      turns: [],
      updatedAt: '<ts>',
    },
  });
});

// ── 2. attachExistingSession onto a channel already bound to a DIFFERENT session (with profileName) ──
test('golden 2: attachExistingSession re-points binding, switches ledger, restores profile', async () => {
  const channel = 'web:g2-channel';
  const sidOld = 'sid-2-old';
  const sidNew = 'sid-2-new';

  // Pre-existing binding + conversation for a different session on this channel.
  await setSessionAsync(channel, sidOld);
  await conversationLedger.initConversation(channel, {
    sessionId: sidOld, sessionName: 'cortex-2-old', backend: 'claude', profileName: 'plan',
  });

  await attachExistingSession(channel, {
    sessionId: sidNew, sessionName: 'cortex-2-new', backend: 'claude', profileName: 'scan',
  });

  // setActiveProfile writes channel-scoped profile state (agent-state, module
  // singleton); observed via getActiveProfile rather than a spy since it is
  // reachable on the isolated home.
  const snapshot = {
    binding: await getSessionAsync(channel),
    conversation: await conversationLedger.getConversation(channel),
    activeProfile: getActiveProfile(channel),
  };

  assert.deepEqual(normalize(snapshot), {
    binding: 'sid-2-new',
    conversation: {
      sessionId: 'sid-2-new',
      sessionName: 'cortex-2-new',
      backend: 'claude',
      profileName: 'scan',
      turns: [],
      updatedAt: '<ts>',
    },
    activeProfile: 'scan',
  });
});

// ── 3. adoptScheduledSession: attach + convertToDirect ──
test('golden 3: adoptScheduledSession attaches a web conduit and converts the record to direct', async () => {
  const { registry } = freshStores();
  const sid = 'sid-3';
  const channel = `web:${sid}`;

  await registry.registerSession('cortex-3', {
    sessionId: sid, channel: 'sched:origin-3', backend: 'claude', kind: 'scheduled',
    origin: 'scheduled', projectId: 'projX', profileName: 'plan', scheduleId: 'sched-3',
  });

  const res = await adoptScheduledSession(registry, sid);

  const snapshot = {
    returnedChannel: res?.channel,
    record: await registry.getById(sid), // convertToDirect target: temp registry
    binding: await getSessionAsync(channel), // attach uses the singleton binding
    conversation: await conversationLedger.getConversation(channel),
  };

  assert.deepEqual(normalize(snapshot), {
    returnedChannel: 'web:sid-3',
    record: {
      name: 'cortex-3',
      sessionId: 'sid-3',
      projectId: 'projX',
      channel: 'web:sid-3', // re-pointed by convertToDirect
      backend: 'claude',
      kind: 'local', // scheduled → local
      origin: 'direct', // scheduled → direct
      createdAt: '<ts>',
      lastUsedAt: '<ts>',
      label: null,
      profileName: 'plan',
      backendSessionId: null,
      scheduleId: 'sched-3', // provenance intentionally KEPT
      browser: null,
      commissionId: null,
      commissionDraft: null,
    },
    binding: 'sid-3',
    conversation: {
      sessionId: 'sid-3',
      sessionName: 'cortex-3',
      backend: 'claude',
      profileName: 'plan',
      turns: [],
      updatedAt: '<ts>',
    },
  });
});

// ── 4. resetChannelSession: clearConversation + unbind ──
test('golden 4: resetChannelSession clears the conversation and unbinds the channel', async () => {
  const channel = 'web:g4-channel';
  const sid = 'sid-4';

  await setSessionAsync(channel, sid);
  await conversationLedger.initConversation(channel, {
    sessionId: sid, sessionName: 'cortex-4', backend: 'claude',
  });

  await resetChannelSession(channel);

  const snapshot = {
    binding: (await getSessionAsync(channel)) ?? '<unbound>', // undefined exactly as today
    conversation: await conversationLedger.getConversation(channel), // null exactly as today
  };

  assert.deepEqual(normalize(snapshot), {
    binding: '<unbound>',
    conversation: null,
  });
});

// ── 5. Turn lifecycle: initAndBeginTurn → setBackupPath → addResponseTs×2 → completeTurn → 2nd turn ──
test('golden 5: turn lifecycle records the turn verbatim (text, response ts, status, exec id, backup)', async () => {
  const { ledger } = freshStores();
  const channel = 'web:g5-channel';
  const userText1 = 'first user message\nwith a newline and unicode ☃ kept verbatim';

  await ledger.initAndBeginTurn(channel, {
    sessionId: 'sid-5', sessionName: 'cortex-5', backend: 'claude', profileName: 'plan',
    userMessageTs: 'u-msg-1', userMessageText: userText1, statusMessageTs: 'status-1',
  });
  await ledger.setBackupPath(channel, 'u-msg-1', '/backups/turn-0.bak');
  await ledger.addResponseTs(channel, 'u-msg-1', 'resp-1a');
  await ledger.addResponseTs(channel, 'u-msg-1', 'resp-1b');
  await ledger.completeTurn(channel, 'u-msg-1', { executionId: 'exec-1' });
  await ledger.beginTurn(channel, { userMessageTs: 'u-msg-2', userMessageText: 'second message text' });

  assert.deepEqual(normalize(await ledger.getConversation(channel)), {
    sessionId: 'sid-5',
    sessionName: 'cortex-5',
    backend: 'claude',
    profileName: 'plan',
    turns: [
      {
        turnIndex: 0,
        userMessageTs: 'u-msg-1',
        userMessageText: 'first user message\nwith a newline and unicode ☃ kept verbatim',
        statusMessageTs: 'status-1',
        responseMessageTimestamps: ['resp-1a', 'resp-1b'],
        executionId: 'exec-1',
        backupPath: '/backups/turn-0.bak',
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
    sessionId: 'sid-6', sessionName: 'cortex-6', backend: 'claude',
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
      sessionName: 'cortex-6',
      backend: 'claude',
      profileName: null,
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
    sessionId: null, sessionName: 'cortex-7', backend: 'claude',
  });
  await ledger.updateSessionId(channel, 'sid-late-7');

  assert.deepEqual(normalize(await ledger.getConversation(channel)), {
    sessionId: 'sid-late-7',
    sessionName: 'cortex-7',
    backend: 'claude',
    profileName: null,
    turns: [],
    updatedAt: '<ts>',
  });
});

// ── 8. switchSession on a channel with existing turns — turns reset, header replaced ──
test('golden 8: switchSession replaces the header and resets turns', async () => {
  const { ledger } = freshStores();
  const channel = 'web:g8-channel';

  await ledger.initConversation(channel, {
    sessionId: 'sid-8a', sessionName: 'cortex-8a', backend: 'claude', profileName: 'plan',
  });
  await ledger.beginTurn(channel, { userMessageTs: 'u1', userMessageText: 'old turn' });

  await ledger.switchSession(channel, {
    sessionId: 'sid-8b', sessionName: 'cortex-8b', backend: 'claude', profileName: 'scan',
  });

  assert.deepEqual(normalize(await ledger.getConversation(channel)), {
    sessionId: 'sid-8b',
    sessionName: 'cortex-8b',
    backend: 'claude',
    profileName: 'scan',
    turns: [],
    updatedAt: '<ts>',
  });
});

// ── 9. registerThreadSession: the registry put for a thread/scheduled session ──
test('golden 9: registerThreadSession keeps track id as sessionId and backend id as backendSessionId', async () => {
  const channel = 'thread:g9-channel';
  const trackSid = 'track-sid-9';
  const backendSid = 'backend-sid-9';

  await registerThreadSession(channel, {
    sessionName: 'cortex-thr-9',
    result: { sessionId: backendSid } as any,
    threadResult: { thread: { steps: [{ sessionName: 'cortex-step', sessionId: trackSid, agentSlotId: 'agent:coder' }] } },
    project: 'projX',
    label: 'nightly run label',
    sessionKind: 'scheduled',
    sessionOrigin: 'scheduled',
    scheduleId: 'sched-9',
  });

  const record = await sessionStore.getById(trackSid); // registered under the track id, not the backend id
  const snapshot = {
    lookupBySessionId: await sessionStore.lookupBySessionId(trackSid),
    lookupBackendId: await sessionStore.lookupBySessionId(backendSid), // no record under the backend id
    record,
    effectiveBackendSessionId: record ? effectiveBackendSessionId(record) : null,
  };

  assert.deepEqual(normalize(snapshot, [[getActiveProfile(channel) ?? '<no-active-profile>', '<profile>']]), {
    lookupBySessionId: 'cortex-thr-9',
    lookupBackendId: null,
    record: {
      name: 'cortex-thr-9',
      sessionId: 'track-sid-9',
      projectId: 'projX',
      channel: 'thread:g9-channel',
      backend: 'claude',
      kind: 'scheduled',
      origin: 'scheduled',
      createdAt: '<ts>',
      lastUsedAt: '<ts>',
      label: 'nightly run label',
      profileName: '<profile>',
      backendSessionId: 'backend-sid-9',
      scheduleId: 'sched-9',
      browser: null,
      commissionId: null,
      commissionDraft: null,
    },
    effectiveBackendSessionId: 'backend-sid-9',
  });
});

// ── 10. switchChannelProfile: getActiveSessionName + updateSession(profileName) + channelHasHistory ──
test('golden 10: switchChannelProfile syncs the record on same-backend and refuses cross-backend with history', async () => {
  const channel = 'slack:g10-channel';
  const sid = 'sid-10';

  setActiveProfile('plan', channel); // deterministic starting backend (claude)
  await sessionStore.registerSession('cortex-10', {
    sessionId: sid, channel, backend: 'claude', kind: 'local', projectId: 'projX', profileName: 'plan',
  });
  await setSessionAsync(channel, sid); // so getActiveSessionName resolves the binding
  await conversationLedger.initConversation(channel, {
    sessionId: sid, sessionName: 'cortex-10', backend: 'claude', profileName: 'plan',
  });

  const recordBefore = await sessionStore.lookupSession('cortex-10');
  const historyBefore = await channelHasHistory(channel);

  // Fresh session (no turns): same-backend switch allowed; record profileName synced.
  const switch1 = await switchChannelProfile({ channel, name: 'scan' });
  const recordAfter1 = await sessionStore.lookupSession('cortex-10');
  const activeProfileAfter1 = getActiveProfile(channel);

  await conversationLedger.beginTurn(channel, { userMessageTs: 'u1', userMessageText: 'now live' });
  const historyAfterTurn = await channelHasHistory(channel);

  // Live conversation: cross-backend switch (execute = pi) rejected, record untouched.
  const switch2 = await switchChannelProfile({ channel, name: 'execute' });
  const recordAfter2 = await sessionStore.lookupSession('cortex-10');

  // Live conversation: same-backend switch (qa = claude) still allowed.
  const switch3 = await switchChannelProfile({ channel, name: 'qa' });
  const recordAfter3 = await sessionStore.lookupSession('cortex-10');

  const snapshot = {
    profileBefore: recordBefore?.profileName,
    historyBefore,
    switch1,
    profileAfter1: recordAfter1?.profileName, // 'scan' proves getActiveSessionName resolved + updateSession ran
    activeProfileAfter1,
    historyAfterTurn,
    switch2,
    profileAfter2: recordAfter2?.profileName, // unchanged: rejected switch does not sync
    switch3,
    profileAfter3: recordAfter3?.profileName,
  };

  assert.deepEqual(normalize(snapshot), {
    profileBefore: 'plan',
    historyBefore: false,
    switch1: { ok: true, name: 'scan', currentBackend: 'claude', targetBackend: 'claude', backendChanged: false },
    profileAfter1: 'scan',
    activeProfileAfter1: 'scan',
    historyAfterTurn: true,
    switch2: { ok: false, name: 'execute', currentBackend: 'claude', targetBackend: 'pi', backendChanged: true, reason: 'cross-backend-live-session' },
    profileAfter2: 'scan',
    switch3: { ok: true, name: 'qa', currentBackend: 'claude', targetBackend: 'claude', backendChanged: false },
    profileAfter3: 'qa',
  });
});

// ── 11. resolveOnNewProfileName reads the registry ONLY ──
// B.T2 deleted the ledger fallback: the registry record's profileName is the single source of truth.
// Case (b) — a registry record with no profile but a ledger conversation that DOES carry one —
// therefore resolves to null now (it was 'scan' before the fallback was removed). The ledger
// conversations below are set up precisely to prove they no longer influence the answer.
test('golden 11: resolveOnNewProfileName reads the registry only; the ledger no longer contributes', async () => {
  const { registry, ledger } = freshStores();
  const deps = {
    lookupRegistryProfile: async (sessionId: string) => {
      const name = await registry.lookupBySessionId(sessionId);
      if (!name) return null;
      return (await registry.lookupSession(name))?.profileName ?? null;
    },
  };

  // (a) registry has the profile → wins (and the disagreeing ledger profile is ignored).
  await registry.registerSession('cortex-11a', {
    sessionId: 'sid-11a', channel: 'web:11a', backend: 'claude', kind: 'local', projectId: 'projX', profileName: 'plan',
  });
  await ledger.initConversation('web:11a', { sessionId: 'sid-11a', sessionName: 'cortex-11a', backend: 'claude', profileName: 'qa' });

  // (b) registry record lacks a profile; the ledger has one but is no longer a fallback → null.
  await registry.registerSession('cortex-11b', {
    sessionId: 'sid-11b', channel: 'web:11b', backend: 'claude', kind: 'local', projectId: 'projX', profileName: null,
  });
  await ledger.initConversation('web:11b', { sessionId: 'sid-11b', sessionName: 'cortex-11b', backend: 'claude', profileName: 'scan' });

  // (c) neither source → null.

  const snapshot = {
    a_registryWins: await resolveOnNewProfileName('web:11a', 'sid-11a', deps),
    b_ledgerFallback: await resolveOnNewProfileName('web:11b', 'sid-11b', deps),
    c_neither: await resolveOnNewProfileName('web:11c', 'sid-11c', deps),
  };

  assert.deepEqual(normalize(snapshot), {
    a_registryWins: 'plan',
    b_ledgerFallback: null, // B.T2: ledger fallback deleted (was 'scan')
    c_neither: null,
  });
});

// ── 12. TUI conduit precedence: an in-memory resolver wins over the persisted bind; null falls through ──
test('golden 12: a conduit resolver outranks the persisted binding and null falls back to it', async () => {
  const { sessions } = freshStores();

  // Persisted bindings: a DIFFERENT one for tui:g12, plus a bind-only channel tui:g12b.
  await sessions.setSessionAsync('tui:g12', 'file-sid-12');
  await sessions.setSessionAsync('tui:g12b', 'file-sid-12b');

  // The resolver is registered on THIS test's own registry instance (which `sessions` wraps), so it
  // cannot leak into other goldens. It only claims tui:g12 and returns null for everything else.
  sessions.registerConduitResolver((channel) =>
    channel === 'tui:g12' ? 'conduit-sid-12' : null,
  );

  const snapshot = {
    providerWins: await sessions.getSessionAsync('tui:g12'), // resolver answer, not file-sid-12
    providerNullFallsThrough: await sessions.getSessionAsync('tui:g12b'), // persisted binding
  };

  assert.deepEqual(normalize(snapshot), {
    providerWins: 'conduit-sid-12',
    providerNullFallsThrough: 'file-sid-12b',
  });
});

// ── 13. No legacy-key collapse: the registry keys on the whole channel string ──
// B.T2 DELETED the sessions.json LEGACY_PREFIXES path. A `claude:<channel>` binding is now just a
// literal channel name; it holds its own binding but no longer resolves when the bare <channel> is
// queried (there is no backend-prefix stripping any more).
test('golden 13: a legacy claude:<channel> binding no longer resolves to the bare channel', async () => {
  const { sessions } = freshStores();
  const channel = 'slack:g13-channel';
  await sessions.setSessionAsync(`claude:${channel}`, 'sid-legacy-13');

  const snapshot = {
    legacyKeyItself: await sessions.getSessionAsync(`claude:${channel}`), // the literal key still holds it
    bareChannel: (await sessions.getSessionAsync(channel)) ?? '<unbound>', // no prefix-strip fallback
  };

  assert.deepEqual(normalize(snapshot), {
    legacyKeyItself: 'sid-legacy-13',
    bareChannel: '<unbound>',
  });
});

// ── 14. Retention: clearBySessionIds + deleteManyBySessionIds — snapshot what remains ──
test('golden 14: retention drops the named sessions from ledger and bindings, keeps the rest', async () => {
  const { sessions, ledger } = freshStores();

  await sessions.setSessionAsync('web:14a', 'sid-14a');
  await sessions.setSessionAsync('web:14b', 'sid-14b');
  await ledger.initConversation('web:14a', { sessionId: 'sid-14a', sessionName: 'cortex-14a', backend: 'claude' });
  await ledger.initConversation('web:14b', { sessionId: 'sid-14b', sessionName: 'cortex-14b', backend: 'claude' });

  const ledgerRemoved = await ledger.clearBySessionIds(['sid-14a']);
  const bindingsRemoved = await sessions.deleteManyBySessionIds(['sid-14a']);

  const snapshot = {
    ledgerRemoved,
    bindingsRemoved,
    ledgerA: await ledger.getConversation('web:14a'), // gone
    ledgerB: await ledger.getConversation('web:14b'), // remains
    bindingA: (await sessions.getSessionAsync('web:14a')) ?? '<unbound>', // gone
    bindingB: await sessions.getSessionAsync('web:14b'), // remains
  };

  assert.deepEqual(normalize(snapshot), {
    ledgerRemoved: 1,
    bindingsRemoved: 1,
    ledgerA: null,
    ledgerB: {
      sessionId: 'sid-14b',
      sessionName: 'cortex-14b',
      backend: 'claude',
      profileName: null,
      turns: [],
      updatedAt: '<ts>',
    },
    bindingA: '<unbound>',
    bindingB: 'sid-14b',
  });
});

// ── 15. Registry update semantics: backendSessionId undefined vs null → effectiveBackendSessionId ──
test('golden 15: effectiveBackendSessionId preserves the undefined (⇒ sessionId) vs null distinction', async () => {
  const { registry } = freshStores();

  // registerSession coerces an omitted backendSessionId to null; an explicit value is kept.
  await registry.registerSession('cortex-15a', {
    sessionId: 'sid-15a', channel: 'web:15a', backend: 'claude', kind: 'local', projectId: 'projX',
    backendSessionId: 'bk-15a',
  });
  await registry.registerSession('cortex-15b', {
    sessionId: 'sid-15b', channel: 'web:15b', backend: 'claude', kind: 'local', projectId: 'projX',
  });
  await registry.updateSession('cortex-15b', { backendSessionId: null }); // stays null explicitly

  const recA = await registry.getById('sid-15a');
  const recB = await registry.getById('sid-15b');

  const snapshot = {
    storedA: recA?.backendSessionId,
    effectiveA: recA ? effectiveBackendSessionId(recA) : null,
    storedB: recB?.backendSessionId,
    effectiveB: recB ? effectiveBackendSessionId(recB) : null,
    // Pure-function pin of the two source-code paths (§8.10): undefined ⇒ sessionId, null ⇒ null.
    pureUndefined: effectiveBackendSessionId({ sessionId: 'sid-x', backendSessionId: undefined }),
    pureNull: effectiveBackendSessionId({ sessionId: 'sid-x', backendSessionId: null }),
  };

  assert.deepEqual(normalize(snapshot), {
    storedA: 'bk-15a',
    effectiveA: 'bk-15a',
    storedB: null,
    effectiveB: null,
    pureUndefined: 'sid-x',
    pureNull: null,
  });
});

// ── 16. Journal replay: a new repo on the same path sees everything; likewise after compactNow ──
test('golden 16: listRecentSessions survives a restart and a compaction unchanged', async () => {
  const filePath = path.join(tmpDir, `reg-replay-${testId++}.jsonl`);
  const repo = new SessionRegistryRepo(filePath);

  await repo.registerSession('cortex-16a', { sessionId: 'sid-16a', channel: 'web:16a', backend: 'claude', kind: 'local', projectId: 'projX', profileName: 'plan' });
  await repo.registerSession('cortex-16b', { sessionId: 'sid-16b', channel: 'web:16b', backend: 'claude', kind: 'local', projectId: 'projX' });
  await repo.registerSession('cortex-16c', { sessionId: 'sid-16c', channel: 'web:16c', backend: 'claude', kind: 'local', projectId: 'projX' });
  await repo.updateSession('cortex-16a', { label: 'labelled A' });

  const original = normalize(await repo.listRecentSessions(20));
  const afterRestart = normalize(await new SessionRegistryRepo(filePath).listRecentSessions(20));

  await repo.compactNow();
  const afterCompactRestart = normalize(await new SessionRegistryRepo(filePath).listRecentSessions(20));

  // One deepEqual: restart and post-compaction restart both equal the live view.
  assert.deepEqual([afterRestart, afterCompactRestart], [original, original]);
});
