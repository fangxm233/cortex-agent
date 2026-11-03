import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleResolveUnsent } from '../../../src/domain/ui-service/mutate/sessions.js';
import type { PendingInjectionRecord } from '../../../src/store/pending-injection-repo.js';
import type { Session } from '../../../src/store/session-registry-repo.js';
import { makeUiDeps } from './ui-deps-fixture.js';

const attachment = { name: 'a.png', path: 'workspace/attachments/s/a.png', size: 3, mimeType: 'image/png', type: 'image' as const };

const unsent: PendingInjectionRecord = {
  id: 'pin-1', sessionId: 'sess-1', channel: 'web:sess-1', messageId: 'web_1', backend: 'claude',
  selection: null, text: 'wire it up', attachments: [attachment],
  createdAt: '2026-10-31T16:29:47.000Z', unsentAt: '2026-10-31T16:30:00.000Z',
};

const session = { sessionId: 'sess-1', projectId: 'general', channel: 'web:sess-1', kind: 'local' } as unknown as Session;

function harness(opts: { session?: Session | null } = {}) {
  const store = new Map([[unsent.id, unsent]]);
  const sent: unknown[] = [];
  const events: any[] = [];
  const deps = makeUiDeps({
    sessionStore: { getById: async () => (opts.session === undefined ? session : opts.session) },
    sendSessionMessage: (msg) => { sent.push(msg); },
    pendingInjections: {
      takeUnsent: async (sessionId, id) => {
        const record = store.get(id);
        if (!record || record.sessionId !== sessionId) return null;
        store.delete(id);
        return record;
      },
      add: async (record) => { store.set(record.id, record); },
    },
  });
  deps.bus.subscribe('session.message.withdrawn', (event) => { events.push(event); });
  return { deps, store, sent, events };
}

test('send routes the unsent message again and withdraws its row everywhere', async () => {
  const h = harness();
  const res = await handleResolveUnsent(h.deps, { sessionId: 'sess-1', pendingId: 'pin-1', action: 'send' });

  assert.equal(res.ok, true);
  assert.deepEqual(h.sent, [{ channel: 'web:sess-1', text: 'wire it up', attachments: [attachment] }]);
  assert.equal(h.store.size, 0);
  assert.deepEqual(h.events.map((e) => [e.sessionId, e.pendingId]), [['sess-1', 'pin-1']]);
});

test('edit hands the message back without sending it', async () => {
  const h = harness();
  const res = await handleResolveUnsent(h.deps, { sessionId: 'sess-1', pendingId: 'pin-1', action: 'edit' });

  assert.deepEqual(res, { ok: true, data: { text: 'wire it up', attachments: [attachment] } });
  assert.deepEqual(h.sent, []);
  assert.equal(h.events.length, 1);
});

test('a second device acting on the same message finds it gone', async () => {
  const h = harness();
  await handleResolveUnsent(h.deps, { sessionId: 'sess-1', pendingId: 'pin-1', action: 'send' });
  const res = await handleResolveUnsent(h.deps, { sessionId: 'sess-1', pendingId: 'pin-1', action: 'edit' });

  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-found');
  assert.equal(h.sent.length, 1, 'sent once');
  assert.equal(h.events.length, 1);
});

test('a send the session refuses keeps the message unsent', async () => {
  const h = harness({ session: null });
  const res = await handleResolveUnsent(h.deps, { sessionId: 'sess-1', pendingId: 'pin-1', action: 'send' });

  assert.equal(res.ok, false);
  assert.equal(h.store.get('pin-1')?.unsentAt, unsent.unsentAt, 'the record is back as it was');
  assert.deepEqual(h.events, [], 'no client drops the row');
});
