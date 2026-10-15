import * as assert from 'node:assert';
import { beforeAll, describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { modelsRepo } from '@store/models-repo.js';
import type { EngineSelection } from '@domain/agents/engine-selection.js';

import { registerSessionRecord, attachExistingSession, resetChannelSession, createDirectSession, adoptScheduledSession } from '@domain/sessions/session-lifecycle.js';
import type { SessionRegistryWriter } from '@domain/sessions/session-lifecycle.js';
import { setSessionAsync, getSessionAsync } from '@domain/sessions/session.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { getChannelSelection, setChannelSelection } from '@domain/agents/config.js';

const selection: EngineSelection = { backend: 'claude', provider: null, model: 'opus', thinking: 'high', mode: 'plan' };
beforeAll(() => {
  mkdirSync(`${process.env.CORTEX_HOME}/config`, { recursive: true });
  writeFileSync(`${process.env.CORTEX_HOME}/config/models.json`, JSON.stringify({ default: selection, favorites: [selection] }));
  modelsRepo.invalidate();
});

// ── registerSessionRecord ────────────────────────────────────────

// ── createDirectSession ─────────────────────────────────────────

describe('createDirectSession', () => {
  it('generates a fresh direct session, binds the channel + ledger, returns the id', async () => {
    let registered: any = null;
    let bound: any = null;
    let ledger: any = null;
    const resolveCalls: string[] = [];

    const fakeStore: SessionRegistryWriter = {
      registerSession: async (opts) => { registered = opts; },
    };

    const result = await createDirectSession(
      {
        sessionStore: fakeStore,
        setChannelSession: async (channel, sessionId) => { bound = { channel, sessionId }; },
        initConversation: async (channel, opts) => { ledger = { channel, ...opts }; },
        resolveBackend: (channel) => { resolveCalls.push(channel); return 'claude'; },
      },
      { projectId: 'proj-web' },
    );

    assert.ok(result.sessionId, 'returns a non-empty sessionId');

    const expectedChannel = 'web:' + result.sessionId;
    assert.deepStrictEqual(registered.selection, selection, 'engine selection is materialized');
    assert.deepStrictEqual(ledger.selection, selection, 'ledger retains the same choice');

    assert.ok(registered, 'registerSession was called');
    assert.strictEqual(registered.sessionId, result.sessionId);
    assert.strictEqual(registered.channel, expectedChannel, 'registered on the web:<id> channel');
    assert.strictEqual(registered.backend, 'claude');
    assert.strictEqual(registered.origin, 'direct', 'origin is direct');
    assert.strictEqual(registered.projectId, 'proj-web');

    assert.deepStrictEqual(bound, { channel: expectedChannel, sessionId: result.sessionId },
      'channel session bound so a later send resumes it');
    assert.strictEqual(ledger.channel, expectedChannel);
    assert.strictEqual(ledger.sessionId, result.sessionId);
    assert.strictEqual(ledger.backend, 'claude');
  });

  it('passes worker fields through for a team worker and omits them for an ordinary session', async () => {
    const registered: any[] = [];
    const deps = {
      sessionStore: {
        registerSession: async (opts: any) => { registered.push(opts); },
      } satisfies SessionRegistryWriter,
      setChannelSession: async () => {},
      initConversation: async () => {},
      resolveBackend: () => 'claude',
    };
    await createDirectSession(deps, { projectId: 'p', teamLeadId: 'sess-lead', workerName: 'scout' });
    await createDirectSession(deps, { projectId: 'p' });
    assert.strictEqual(registered[0].teamLeadId, 'sess-lead');
    assert.strictEqual(registered[0].workerName, 'scout');
    assert.strictEqual(registered[0].origin, 'direct', 'a worker stays an ordinary direct session');
    assert.ok(!('teamLeadId' in registered[1]), 'ordinary sessions carry no worker fields');
  });

  it('opens a schedule\'s run as a scheduled session on its own web channel', async () => {
    const registered: any[] = [];
    const deps = {
      sessionStore: {
        registerSession: async (opts: any) => { registered.push(opts); },
      } satisfies SessionRegistryWriter,
      setChannelSession: async () => {},
      initConversation: async () => {},
      resolveBackend: () => 'claude',
    };
    const run = await createDirectSession(deps, { projectId: 'p', scheduleId: 'sch-1', label: 'digest' });
    await createDirectSession(deps, { projectId: 'p' });
    assert.strictEqual(run.channel, `web:${run.sessionId}`);
    assert.strictEqual(registered[0].kind, 'scheduled');
    assert.strictEqual(registered[0].origin, 'scheduled');
    assert.strictEqual(registered[0].scheduleId, 'sch-1');
    assert.strictEqual(registered[0].label, 'digest');
    assert.strictEqual(registered[1].kind, 'local');
    assert.strictEqual(registered[1].origin, 'direct');
    assert.ok(!('scheduleId' in registered[1]), 'ordinary sessions carry no schedule');
  });

  it('generates a distinct sessionId + channel per call', async () => {
    const fakeStore: SessionRegistryWriter = {
      registerSession: async () => {},
    };
    const deps = {
      sessionStore: fakeStore,
      setChannelSession: async () => {},
      initConversation: async () => {},
      resolveBackend: () => 'claude',
    };
    const a = await createDirectSession(deps, { projectId: 'p' });
    const b = await createDirectSession(deps, { projectId: 'p' });
    assert.notStrictEqual(a.sessionId, b.sessionId, 'unique ids');
  });

  it('registers the board a new session starts bound to', async () => {
    const registered: Array<{ boardId?: string | null }> = [];
    const deps = {
      sessionStore: { registerSession: async (opts) => { registered.push(opts); } } as SessionRegistryWriter,
      setChannelSession: async () => {},
      initConversation: async () => {},
      resolveBackend: () => 'claude',
    };
    await createDirectSession(deps, { projectId: 'p', boardId: 'b-1' });
    await createDirectSession(deps, { projectId: 'p' });
    assert.deepStrictEqual(registered.map(r => r.boardId), ['b-1', null]);
  });
});

// ── attachExistingSession ───────────────────────────────────────

describe('attachExistingSession', () => {
  it('switches session in sessions.json and conversation ledger (selection null)', async () => {
    const channel = 'c1-attach';
    const opts = { sessionId: 'sid-attach', backend: 'claude', selection: null };

    await attachExistingSession(channel, opts);

    const storedId = await getSessionAsync(channel);
    assert.strictEqual(storedId, 'sid-attach', 'sessions.json points at the session');

    const conv = await conversationLedger.getConversation(channel);
    assert.ok(conv, 'conversation ledger has an entry');
    assert.strictEqual(conv!.sessionId, 'sid-attach');
    assert.strictEqual(conv!.backend, 'claude');
  });

  it('restores the complete session selection over a different channel selection', async () => {
    const channel = 'c1-attach-selection';
    setChannelSelection(channel, { ...selection, model: 'other', thinking: 'low', mode: 'api' });
    await attachExistingSession(channel, {
      sessionId: 'sid-attach-p', backend: 'claude', selection,
    });
    assert.deepStrictEqual(getChannelSelection(channel), selection);
    const conv = await conversationLedger.getConversation(channel);
    assert.deepStrictEqual(conv!.selection, selection, 'thinking and mode survive resume');
  });
});

// ── adoptScheduledSession ───────────────────────────────────────

describe('adoptScheduledSession', () => {
  const scheduledRecord = {
sessionId: 'sid-sched-1', channel: 'cortex-self', backend: 'claude',
    origin: 'scheduled' as const, selection: null,
  };

  type AdoptRecord = Omit<typeof scheduledRecord, 'origin'> & { origin: 'scheduled' | 'direct' };
  function makeStore(record: AdoptRecord | null) {
    const converted: Array<{ sessionId: string; channel: string }> = [];
    return {
      converted,
      store: {
        getById: async () => record,
        convertToDirect: async (sessionId: string, opts: { channel: string }) => {
          converted.push({ sessionId, channel: opts.channel });
          return record;
        },
      },
    };
  }

  it('attaches a web:<sid> channel to the run and re-points the registry record', async () => {
    const { store, converted } = makeStore(scheduledRecord);

    const result = await adoptScheduledSession(store, 'sid-sched-1');

    assert.deepStrictEqual(result, { channel: 'web:sid-sched-1' });
    const storedId = await getSessionAsync('web:sid-sched-1');
    assert.strictEqual(storedId, 'sid-sched-1', 'sessions.json binds the new channel to the track id');
    const conv = await conversationLedger.getConversation('web:sid-sched-1');
    assert.ok(conv, 'conversation ledger switched to the session');
    assert.strictEqual(conv!.sessionId, 'sid-sched-1');
    assert.deepStrictEqual(converted, [{ sessionId: 'sid-sched-1', channel: 'web:sid-sched-1' }],
      'registry record re-pointed at the new channel');
  });

  it('re-points a run already on its own web channel without re-attaching it', async () => {
    // A live turn may be running on that conduit: switching its ledger again would reset it.
    const run = { ...scheduledRecord, sessionId: 'sid-sched-own', channel: 'web:sid-sched-own' };
    const { store, converted } = makeStore(run);
    const result = await adoptScheduledSession(store, 'sid-sched-own');
    assert.deepStrictEqual(result, { channel: 'web:sid-sched-own' });
    assert.strictEqual(await conversationLedger.getConversation('web:sid-sched-own'), null, 'ledger untouched');
    assert.deepStrictEqual(converted, [{ sessionId: 'sid-sched-own', channel: 'web:sid-sched-own' }]);
  });

  it('returns null for an unknown session without touching any store', async () => {
    const { store, converted } = makeStore(null);
    const result = await adoptScheduledSession(store, 'sid-ghost');
    assert.strictEqual(result, null);
    assert.strictEqual(converted.length, 0);
    const storedId = await getSessionAsync('web:sid-ghost');
    assert.strictEqual(storedId, undefined, 'no channel binding created');
  });

  it('is idempotent: an already-direct record returns its current channel unconverted', async () => {
    const direct = { ...scheduledRecord, sessionId: 'sid-direct-1', channel: 'web:sid-direct-1', origin: 'direct' as const };
    const { store, converted } = makeStore(direct);
    const result = await adoptScheduledSession(store, 'sid-direct-1');
    assert.deepStrictEqual(result, { channel: 'web:sid-direct-1' });
    assert.strictEqual(converted.length, 0, 'no re-conversion');
  });
});

// ── resetChannelSession ─────────────────────────────────────────

describe('resetChannelSession', () => {
  it('unbinds the channel session and clears the ledger', async () => {
    const channel = 'c1-reset';

    await setSessionAsync(channel, 'sid-reset-current');
    await conversationLedger.initConversation(channel, {
      sessionId: 'sid-reset-current',
      backend: 'claude',
    });

    assert.ok(await getSessionAsync(channel), 'session exists before reset');
    const convBefore = await conversationLedger.getConversation(channel);
    assert.ok(convBefore, 'conversation exists before reset');

    await resetChannelSession(channel);

    // One channel, one binding: a single unbind clears it (no legacy key forms exist any more).
    assert.strictEqual(await getSessionAsync(channel), undefined, 'session cleared');

    // Assert: conversation cleared
    const convAfter = await conversationLedger.getConversation(channel);
    assert.strictEqual(convAfter, null, 'conversation cleared');
  });
});
