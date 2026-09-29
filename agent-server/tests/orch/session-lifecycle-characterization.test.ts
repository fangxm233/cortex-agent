import { test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleNewCmd, createResumeHandler } from '../../src/orchestration/routing/commands/session.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { getSessionAsync, setSessionAsync } from '../../src/domain/sessions/session.js';
import { conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { MockAdapter } from '../../src/platform/testing.js';

// ── handleNewCmd test ─────────────────────────────────────────────────────────

test('handleNewCmd clears sessions for all backends and the ledger', async () => {
  const channel = 'c0-newcmd';
  const ALL_BACKENDS = ['claude', 'pi'];

  // Seed sessions for all backends
  for (const b of ALL_BACKENDS) {
    await setSessionAsync(channel, crypto.randomUUID(), b);
  }

  // Seed a ledger conversation
  await conversationLedger.initConversation(channel, {
    sessionId: crypto.randomUUID(),
    sessionName: 'cortex-x',
    backend: 'claude',
  });

  const adapter = new MockAdapter({ adminChannel: 'admin' });

  await handleNewCmd(channel, adapter, { skipHook: true });

  // Assert: all backend sessions cleared
  for (const b of ALL_BACKENDS) {
    const s = await getSessionAsync(channel, b);
    assert.equal(s, undefined);
  }

  // Assert: ledger conversation cleared
  const conv = await conversationLedger.getConversation(channel);
  assert.equal(conv, null);
});

// ── createResumeHandler test ─────────────────────────────────────────────────

test('createResumeHandler (arg path) attaches to an existing session', async () => {
  const sid = crypto.randomUUID();
  const channel = 'c4-resume';

  await sessionStore.registerSession('cortex-resume-c4', {
    sessionId: sid,
    channel,
    backend: 'claude',
    kind: 'local',
    projectId: 'general',
  });

  const adapter = new MockAdapter({ adminChannel: 'admin' });

  await createResumeHandler()(channel, adapter, '!resume cortex-resume-c4');

  // Assert: sessions.json points at the resumed session
  const stored = await getSessionAsync(channel, 'claude');
  assert.equal(stored, sid);

  // Assert: conversation ledger switched to the resumed session
  const conv = await conversationLedger.getConversation(channel);
  assert.equal(conv?.sessionId, sid);
  assert.equal(conv?.sessionName, 'cortex-resume-c4');
});

