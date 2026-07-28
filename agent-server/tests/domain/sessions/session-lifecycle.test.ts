import '../../_test-home.js';
import * as assert from 'node:assert';
import { describe, it } from 'vitest';

import { registerNamedSession, attachExistingSession, resetChannelSession, createDirectSession, SESSION_BACKENDS } from '@domain/sessions/session-lifecycle.js';
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

// ── resetChannelSession ─────────────────────────────────────────

describe('resetChannelSession', () => {
  it('clears all backend sessions, cleans backups, and clears conversation ledger', async () => {
    const channel = 'c1-reset';

    // Seed: write sessions for all backends + init conversation
    await setSessionAsync(channel, 'sid-reset-claude', 'claude');
    await setSessionAsync(channel, 'sid-reset-pi', 'pi');
    await conversationLedger.initConversation(channel, {
      sessionId: 'sid-reset-claude',
      sessionName: 'cortex-reset',
      backend: 'claude',
    });

    // Confirm seeded state
    for (const b of SESSION_BACKENDS) {
      const sid = await getSessionAsync(channel, b);
      assert.ok(sid, `session exists for backend ${b} before reset`);
    }
    const convBefore = await conversationLedger.getConversation(channel);
    assert.ok(convBefore, 'conversation exists before reset');

    await resetChannelSession(channel);

    // Assert: all backends cleared
    for (const b of SESSION_BACKENDS) {
      const sid = await getSessionAsync(channel, b);
      assert.strictEqual(sid, undefined, `session cleared for backend ${b}`);
    }

    // Assert: conversation cleared
    const convAfter = await conversationLedger.getConversation(channel);
    assert.strictEqual(convAfter, null, 'conversation cleared');
  });
});
