import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolveSessionName } from '../../src/orchestration/agent-runner.js';
import { handleNewCmd, handleResumeCmd } from '../../src/orchestration/routing/commands/session.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { getSessionAsync, setSessionAsync } from '../../src/domain/sessions/session.js';
import { conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { getActiveProfile, resolveBackendForChannel } from '../../src/domain/agents/index.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { PlatformAdapter } from '../../src/platform/adapter.js';

// Stub adapter for tests 1-3: resolveSessionName only calls resolveInboundProject
const stubAdapter = { resolveInboundProject: async () => 'projX' } as unknown as PlatformAdapter;

// ── resolveSessionName tests ──────────────────────────────────────────────────

test('resolveSessionName returns existing name for a known sessionId (no new record)', async () => {
  const sid = crypto.randomUUID();
  const channel = 'c0-existing';
  await sessionStore.registerSession('cortex-known-c0', {
    sessionId: sid,
    channel,
    backend: 'claude',
    kind: 'local',
    projectId: 'general',
  });

  const name = await resolveSessionName(sid, channel, 'hello', stubAdapter);
  assert.equal(name, 'cortex-known-c0');

  // Verify the record is still intact (no duplicate/overwrite)
  const stillThere = await sessionStore.lookupBySessionId(sid);
  assert.equal(stillThere, 'cortex-known-c0');
});

test('resolveSessionName registers a new record with correct fields for an unknown sessionId', async () => {
  const sid = crypto.randomUUID();
  const channel = 'c0-new';
  const longMsg = 'x'.repeat(100);

  const name = await resolveSessionName(sid, channel, longMsg, stubAdapter);
  assert(name);
  assert(typeof name === 'string');
  assert(name.length > 0);

  const rec = await sessionStore.getById(sid);
  assert(rec !== null);
  assert.equal(rec.channel, channel);
  assert.equal(rec.kind, 'local');
  assert.equal(rec.backend, resolveBackendForChannel(channel));
  assert.equal(rec.projectId, 'projX');
  assert.equal(rec.label, longMsg.substring(0, 60));
  assert.equal(rec.label?.length, 60);
  assert.equal(rec.profileName, getActiveProfile(channel));
});

test('resolveSessionName generates a name without registering when sessionId is null', async () => {
  const channel = 'c0-null';

  // generateSessionName produces a name like cortex-XXXXXX
  const name = await resolveSessionName(null, channel, 'hi', stubAdapter);
  assert(name);
  assert(typeof name === 'string');
  assert(name.length > 0);
  // No registry record is created for a null sessionId — just confirm no throw
});

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

  // Assert: adapter recorded a "new conversation" message
  const hasNewConv = adapter.posted.some(p =>
    typeof p.content.text === 'string' && p.content.text.includes('new conversation')
  );
  assert(hasNewConv);
});

// ── handleResumeCmd test ──────────────────────────────────────────────────────

test('handleResumeCmd (arg path) attaches to an existing session', async () => {
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

  await handleResumeCmd(channel, adapter, '!resume cortex-resume-c4');

  // Assert: sessions.json points at the resumed session
  const stored = await getSessionAsync(channel, 'claude');
  assert.equal(stored, sid);

  // Assert: conversation ledger switched to the resumed session
  const conv = await conversationLedger.getConversation(channel);
  assert.equal(conv?.sessionId, sid);
  assert.equal(conv?.sessionName, 'cortex-resume-c4');

  // Assert: adapter posted a "Switched to session" message
  const hasSwitched = adapter.posted.some(p =>
    typeof p.content.text === 'string' && p.content.text.includes('Switched to session')
  );
  assert(hasSwitched);
});

