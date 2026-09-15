import '../../_test-home.js';
import * as assert from 'node:assert';
import { describe, it } from 'vitest';

import { registerNamedSession, attachExistingSession, resetChannelSession, createDirectSession, adoptScheduledSession } from '@domain/sessions/session-lifecycle.js';
import { sessionRepo } from '@store/session-repo.js';
import { resetSettingsForTests } from '@core/settings.js';
import { STORE_DIR } from '@core/paths.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

const SESSIONS_PATH = joinPath(STORE_DIR, 'sessions.json');

async function readSessionsFile(): Promise<Record<string, string>> {
  try { return JSON.parse(readFileSync(SESSIONS_PATH, 'utf8')); } catch { return {}; }
}

/** Write pre-P3.2 `backend:channel` keys straight to disk — the repo API no longer emits them. */
async function seedLegacyKeys(channel: string, ids: Record<string, string>): Promise<void> {
  const data = await readSessionsFile();
  for (const [backend, id] of Object.entries(ids)) data[`${backend}:${channel}`] = id;
  writeFileSync(SESSIONS_PATH, JSON.stringify(data));
  sessionRepo.invalidate();
}
import type { SessionRegistryWriter } from '@domain/sessions/session-lifecycle.js';
import { setSessionAsync, getSessionAsync } from '@domain/sessions/session.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { getActiveProfile } from '@domain/agents/index.js';

// ── registerNamedSession ────────────────────────────────────────

describe('registerNamedSession', () => {
  it('calls generateSessionName and registerSession with kind:local by default, label/profileName null when omitted', async () => {
    let generateCount = 0;
    let registered: any = null;

    const fakeStore: SessionRegistryWriter = {
      generateSessionName: async () => { generateCount++; return 'cortex-fake'; },
      registerSession: async (name, opts) => { registered = { name, ...opts }; },
    };

    const name = await registerNamedSession(fakeStore, {
      sessionId: 'sid-1',
      channel: 'c1-reg-default',
      backend: 'claude',
      projectId: 'proj-x',
    });

    assert.strictEqual(generateCount, 1, 'generateSessionName called once');
    assert.strictEqual(name, 'cortex-fake', 'returns generated name');
    assert.ok(registered, 'registerSession was called');
    assert.strictEqual(registered.name, 'cortex-fake');
    assert.strictEqual(registered.sessionId, 'sid-1');
    assert.strictEqual(registered.channel, 'c1-reg-default');
    assert.strictEqual(registered.backend, 'claude');
    assert.strictEqual(registered.kind, 'local', 'default kind is local');
    assert.strictEqual(registered.projectId, 'proj-x');
    assert.strictEqual(registered.label, null, 'default label is null');
    assert.strictEqual(registered.profileName, null, 'default profileName is null');
  });

  it('passes through label and profileName when provided', async () => {
    let registered: any = null;

    const fakeStore: SessionRegistryWriter = {
      generateSessionName: async () => 'cortex-labeld',
      registerSession: async (name, opts) => { registered = { name, ...opts }; },
    };

    await registerNamedSession(fakeStore, {
      sessionId: 'sid-2',
      channel: 'c1-reg-label',
      backend: 'pi',
      projectId: 'proj-y',
      kind: 'scheduled',
      label: 'my-label',
      profileName: 'my-profile',
    });

    assert.strictEqual(registered.kind, 'scheduled');
    assert.strictEqual(registered.label, 'my-label');
    assert.strictEqual(registered.profileName, 'my-profile');
  });
});

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
  it('clears the channel session in every key form, cleans backups, and clears the ledger', async () => {
    const channel = 'c1-reset';

    // Seed both the current key and the pre-P3.2 backend-prefixed forms, so the reset is tested
    // against a home that has not been through the boot migration yet.
    await sessionRepo.setSessionAsync(channel, 'sid-reset-current');
    await seedLegacyKeys(channel, { claude: 'sid-reset-claude', pi: 'sid-reset-pi' });
    await conversationLedger.initConversation(channel, {
      sessionId: 'sid-reset-claude',
      sessionName: 'cortex-reset',
      backend: 'claude',
    });

    assert.ok(await getSessionAsync(channel), 'session exists before reset');
    const convBefore = await conversationLedger.getConversation(channel);
    assert.ok(convBefore, 'conversation exists before reset');

    await resetChannelSession(channel);

    // One channel, one binding: a single delete clears the key and both legacy forms.
    assert.strictEqual(await getSessionAsync(channel), undefined, 'session cleared');
    const raw = await readSessionsFile();
    for (const key of [channel, `claude:${channel}`, `pi:${channel}`]) {
      assert.strictEqual(key in raw, false, `no ${key} entry survives the reset`);
    }

    // Assert: conversation cleared
    const convAfter = await conversationLedger.getConversation(channel);
    assert.strictEqual(convAfter, null, 'conversation cleared');
  });
});
