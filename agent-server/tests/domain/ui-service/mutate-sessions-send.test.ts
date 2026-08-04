import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSendSession } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { Session } from '../../../src/store/session-registry-repo.js';

interface SendCall { sessionId: string; channel: string; text: string; attachments?: unknown }

function makeDeps(session: Session | null, sink: SendCall[], extra: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => session },
    sendSessionMessage: (opts) => { sink.push({ sessionId: opts.sessionId, channel: opts.channel, text: opts.text, attachments: opts.attachments }); },
    ...extra,
  } as unknown as UiServiceDeps;
}

const session = (channel: string): Session => ({
  name: 'cortex-1', sessionId: 'sess-1', projectId: 'general', channel,
  backend: 'claude', kind: 'local', createdAt: '', lastUsedAt: '', label: null,
} as unknown as Session);

const scheduledSession = (): Session => ({
  name: 'cortex-2', sessionId: 'sess-2', projectId: 'general', channel: 'cortex-self',
  backend: 'claude', kind: 'scheduled', origin: 'scheduled', createdAt: '', lastUsedAt: '',
  label: null, scheduleId: 'sch1',
} as unknown as Session);

test('sessions.send returns not-found when the session does not exist', async () => {
  const sink: SendCall[] = [];
  const res = await handleSendSession(makeDeps(null, sink), { sessionId: 'ghost', text: 'hi' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.equal(sink.length, 0, 'no send is dispatched for a missing session');
});

test('sessions.send accepts + routes to the session channel, fire-and-forget', async () => {
  const sink: SendCall[] = [];
  const res = await handleSendSession(makeDeps(session('C123'), sink), { sessionId: 'sess-1', text: 'run it' });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data, { accepted: true });
  assert.equal(sink.length, 1);
  assert.equal(sink[0].sessionId, 'sess-1');
  assert.equal(sink[0].channel, 'C123');
  assert.equal(sink[0].text, 'run it');
  assert.equal(sink[0].attachments, undefined);
});

// ── scheduled-run adoption (design 27b: replying converts the run) ──

test('sessions.send on a scheduled session adopts it first and routes to the adopted channel', async () => {
  const sink: SendCall[] = [];
  const adopted: string[] = [];
  const deps = makeDeps(scheduledSession(), sink, {
    adoptScheduledSession: async ({ sessionId }) => { adopted.push(sessionId); return { channel: 'web:sess-2' }; },
  });
  const res = await handleSendSession(deps, { sessionId: 'sess-2', text: 'follow up' });
  assert.equal(res.ok, true);
  assert.deepEqual(adopted, ['sess-2'], 'conversion runs before the send');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].channel, 'web:sess-2', 'send goes to the adopted web channel, not the project channel');
  assert.equal(sink[0].sessionId, 'sess-2');
});

test('sessions.send on a scheduled session is not-available when adoption is not wired', async () => {
  const sink: SendCall[] = [];
  const res = await handleSendSession(makeDeps(scheduledSession(), sink), { sessionId: 'sess-2', text: 'hi' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-available');
  assert.equal(sink.length, 0, 'no send is dispatched to the shared project channel');
});

test('sessions.send maps a failed adoption to not-found without sending', async () => {
  const sink: SendCall[] = [];
  const deps = makeDeps(scheduledSession(), sink, { adoptScheduledSession: async () => null });
  const res = await handleSendSession(deps, { sessionId: 'sess-2', text: 'hi' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.equal(sink.length, 0);
});
