import { beforeAll, test } from 'vitest';
import { seedSelections } from './selection-fixture.js';
beforeAll(seedSelections);
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleNewCmd, createResumeHandler } from '../../src/orchestration/routing/commands/session.js';
import { setLocale } from '../../src/core/i18n.js';
import { sessionStore } from '../../src/store/session-registry-repo.js';
import { getSessionAsync, setSessionAsync } from '../../src/domain/sessions/session.js';
import { conversationLedger } from '../../src/store/conversation-ledger-repo.js';
import { MockAdapter } from '../../src/platform/testing.js';

// ── handleNewCmd test ─────────────────────────────────────────────────────────

test('handleNewCmd clears the channel session and the ledger', async () => {
  const channel = 'c0-newcmd';

  // Seed the channel binding
  await setSessionAsync(channel, crypto.randomUUID());

  // Seed a ledger conversation
  await conversationLedger.initConversation(channel, {
    sessionId: crypto.randomUUID(),
    backend: 'claude',
  });

  const adapter = new MockAdapter({ adminChannel: 'admin' });

  await handleNewCmd(channel, adapter, { skipHook: true });

  // Assert: channel binding cleared
  assert.equal(await getSessionAsync(channel), undefined);

  // Assert: ledger conversation cleared
  const conv = await conversationLedger.getConversation(channel);
  assert.equal(conv, null);
});

// ── createResumeHandler test ─────────────────────────────────────────────────

test('createResumeHandler (arg path) attaches to an existing session', async () => {
  const sid = crypto.randomUUID();
  const channel = 'c4-resume';

  await sessionStore.registerSession({
    sessionId: sid,
    channel,
    backend: 'claude',
    kind: 'local',
    projectId: 'general',
  });

  const adapter = new MockAdapter({ adminChannel: 'admin' });

  await createResumeHandler()(channel, adapter, `!resume ${sid}`);

  // Assert: sessions.json points at the resumed session
  const stored = await getSessionAsync(channel);
  assert.equal(stored, sid);

  // Assert: conversation ledger switched to the resumed session
  const conv = await conversationLedger.getConversation(channel);
  assert.equal(conv?.sessionId, sid);
});

test('!resume accepts full IDs and unique prefixes, rejects short or ambiguous prefixes with localized matches', async () => {
  const ids = [
    'abc12300-0000-4000-8000-000000000001',
    'abc12311-0000-4000-8000-000000000002',
  ];
  for (const id of ids) {
    await sessionStore.registerSession({ sessionId: id, channel: `web:${id}`, backend: 'claude', kind: 'local', projectId: 'general' });
  }
  const channel = 'c4-resume-prefix';
  const adapter = new MockAdapter({ adminChannel: 'admin' });
  const resume = createResumeHandler();
  await resume(channel, adapter, '!resume abc1230');
  assert.equal(await getSessionAsync(channel), ids[0], 'unique seven-character prefix resolves');
  await resume(channel, adapter, `!resume ${ids[1]}`);
  assert.equal(await getSessionAsync(channel), ids[1], 'full ID wins');

  await resume(channel, adapter, '!resume abc12');
  assert.equal(await getSessionAsync(channel), ids[1], 'short prefix leaves binding untouched');
  assert.match(adapter.posted.at(-1)!.content.text, /at least 6 characters/);

  await resume(channel, adapter, '!resume abc123');
  assert.equal(await getSessionAsync(channel), ids[1], 'ambiguous prefix leaves binding untouched');
  assert.match(adapter.posted.at(-1)!.content.text, /matches multiple sessions/);
  for (const id of ids) assert.ok(adapter.posted.at(-1)!.content.text.includes(id));

  setLocale('zh');
  try {
    await resume(channel, adapter, '!resume abc123');
    assert.match(adapter.posted.at(-1)!.content.text, /匹配多个会话/);
    for (const id of ids) assert.ok(adapter.posted.at(-1)!.content.text.includes(id));
  } finally {
    setLocale('en');
  }
});

