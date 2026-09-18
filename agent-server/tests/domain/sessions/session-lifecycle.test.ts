import '../../_test-home.js';
import * as assert from 'node:assert';
import { describe, it } from 'vitest';

import { registerNamedSession, attachExistingSession, resetChannelSession, createDirectSession, adoptScheduledSession } from '@domain/sessions/session-lifecycle.js';
import { resetSettingsForTests } from '@core/settings.js';
import type { SessionRegistryWriter } from '@domain/sessions/session-lifecycle.js';
import { setSessionAsync, getSessionAsync } from '@domain/sessions/session.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { getActiveProfile } from '@domain/agents/index.js';

// ── registerNamedSession ────────────────────────────────────────

// ── createDirectSession ─────────────────────────────────────────

describe('createDirectSession', () => {
  it('generates a fresh direct session, binds the channel + ledger, returns the id', async () => {
    let registered: any = null;
    let bound: any = null;
    let ledger: any = null;
    const resolveCalls: string[] = [];

    const fakeStore: SessionRegistryWriter = {
      generateSessionName: async () => 'cortex-new',
      registerSession: async (name, opts) => { registered = { name, ...opts }; },
    };

    const result = await createDirectSession(
      {
        sessionStore: fakeStore,
        setChannelSession: async (channel, sessionId, backend) => { bound = { channel, sessionId, backend }; },
        initConversation: async (channel, opts) => { ledger = { channel, ...opts }; },
        resolveBackend: (channel) => { resolveCalls.push(channel); return 'claude'; },
      },
      { projectId: 'proj-web' },
    );

    assert.ok(result.sessionId, 'returns a non-empty sessionId');
    assert.strictEqual(result.sessionName, 'cortex-new', 'returns the generated name');

    const expectedChannel = 'web:' + result.sessionId;
    assert.strictEqual(resolveCalls[0], expectedChannel, 'backend resolved for the web channel');

    assert.ok(registered, 'registerSession was called');
    assert.strictEqual(registered.sessionId, result.sessionId);
    assert.strictEqual(registered.channel, expectedChannel, 'registered on the web:<id> channel');
    assert.strictEqual(registered.backend, 'claude');
    assert.strictEqual(registered.origin, 'direct', 'origin is direct');
    assert.strictEqual(registered.projectId, 'proj-web');

    assert.deepStrictEqual(bound, { channel: expectedChannel, sessionId: result.sessionId, backend: 'claude' },
      'channel session bound so a later send resumes it');
    assert.strictEqual(ledger.channel, expectedChannel);
    assert.strictEqual(ledger.sessionId, result.sessionId);
    assert.strictEqual(ledger.sessionName, 'cortex-new');
    assert.strictEqual(ledger.backend, 'claude');
  });

  it('generates a distinct sessionId + channel per call', async () => {
    const fakeStore: SessionRegistryWriter = {
      generateSessionName: async () => 'cortex-x',
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

  it('refuses a commission request when settings.commissionEnabled is switched off, creating nothing', async () => {
    let registerCalls = 0;
    const deps = {
      sessionStore: {
        generateSessionName: async () => 'cortex-x',
        registerSession: async () => { registerCalls++; },
      } as SessionRegistryWriter,
      setChannelSession: async () => {},
      initConversation: async () => {},
      resolveBackend: () => 'claude',
    };

    // Refusing beats downgrading: a caller that asked for a commission and silently got an
    // ordinary session would only find out much later.
    process.env.CORTEX_COMMISSION_ENABLED = '0';
    resetSettingsForTests();
    try {
      await assert.rejects(
        () => createDirectSession(deps, { projectId: 'p', commission: { mode: 'new' } }),
        /Commission mode is disabled/,
      );
      assert.strictEqual(registerCalls, 0, 'no session registered');

      // A create without a commission is untouched by the switch.
      const ordinary = await createDirectSession(deps, { projectId: 'p' });
      assert.ok(ordinary.sessionId);
      assert.strictEqual(registerCalls, 1);
    } finally {
      delete process.env.CORTEX_COMMISSION_ENABLED;
      resetSettingsForTests();
    }
  });
});

// ── attachExistingSession ───────────────────────────────────────

describe('attachExistingSession', () => {
  it('switches session in sessions.json and conversation ledger (profileName null)', async () => {
    const channel = 'c1-attach';
    const opts = { sessionId: 'sid-attach', sessionName: 'cortex-y', backend: 'claude', profileName: null };

    await attachExistingSession(channel, opts);

    const storedId = await getSessionAsync(channel, 'claude');
    assert.strictEqual(storedId, 'sid-attach', 'sessions.json points at the session');

    const conv = await conversationLedger.getConversation(channel);
    assert.ok(conv, 'conversation ledger has an entry');
    assert.strictEqual(conv!.sessionId, 'sid-attach');
    assert.strictEqual(conv!.sessionName, 'cortex-y');
    assert.strictEqual(conv!.backend, 'claude');
  });

  it('restores the active profile when profileName is provided', async () => {
    const channel = 'c1-attach-profile';
    await attachExistingSession(channel, {
      sessionId: 'sid-attach-p', sessionName: 'cortex-p', backend: 'claude', profileName: 'qa',
    });

    assert.strictEqual(getActiveProfile(channel), 'qa', 'active profile restored to the session profile');
    const conv = await conversationLedger.getConversation(channel);
    assert.strictEqual(conv!.profileName, 'qa', 'ledger carries the restored profile');
  });
});

// ── adoptScheduledSession ───────────────────────────────────────

describe('adoptScheduledSession', () => {
  const scheduledRecord = {
    name: 'cortex-sched', sessionId: 'sid-sched-1', channel: 'cortex-self', backend: 'claude',
    origin: 'scheduled' as const, profileName: null,
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
    const storedId = await getSessionAsync('web:sid-sched-1', 'claude');
    assert.strictEqual(storedId, 'sid-sched-1', 'sessions.json binds the new channel to the track id');
    const conv = await conversationLedger.getConversation('web:sid-sched-1');
    assert.ok(conv, 'conversation ledger switched to the session');
    assert.strictEqual(conv!.sessionId, 'sid-sched-1');
    assert.strictEqual(conv!.sessionName, 'cortex-sched');
    assert.deepStrictEqual(converted, [{ sessionId: 'sid-sched-1', channel: 'web:sid-sched-1' }],
      'registry record re-pointed at the new channel');
  });

  it('returns null for an unknown session without touching any store', async () => {
    const { store, converted } = makeStore(null);
    const result = await adoptScheduledSession(store, 'sid-ghost');
    assert.strictEqual(result, null);
    assert.strictEqual(converted.length, 0);
    const storedId = await getSessionAsync('web:sid-ghost', 'claude');
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
      sessionName: 'cortex-reset',
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
