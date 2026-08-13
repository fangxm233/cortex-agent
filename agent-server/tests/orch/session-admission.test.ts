// input:  session registry repo, send handler, and fire-and-forget session send seam
// output: send admission touch sequencing and not-found rejection regressions
// pos:    Verifies send-vs-sweep admission behavior
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo } from '../../src/store/session-registry-repo.js';
import { handleSendSession } from '../../src/domain/ui-service/mutate/sessions.js';

function registerOpts(id: string) {
  return {
    sessionId: id,
    channel: `web:${id}`,
    backend: 'claude',
    kind: 'local' as const,
    projectId: 'proj',
    label: 'label',
  };
}

async function makeRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-admission-'));
  return new SessionRegistryRepo(path.join(root, 'session-registry.jsonl'));
}

test('sessions.send awaits touchForUse before accepting and rejects if deletion wins before touch', async () => {
  const repo = await makeRepo();
  await repo.registerSession('cortex-race', registerOpts('track-race'));
  await repo.updateSession('cortex-race', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  const pending = await repo.beginDeleteExpired(new Date('2021-01-01T00:00:00.000Z'), []);
  assert.deepEqual(pending.map((entry) => entry.session.sessionId), ['track-race']);

  let sends = 0;
  const result = await handleSendSession({
    sessionStore: {
      getById: async () => ({ sessionId: 'track-race', channel: 'web:track-race', kind: 'local' }),
      touchForUse: (sessionId: string) => repo.touchForUse(sessionId),
      listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [],
    },
    sendSessionMessage: () => { sends += 1; },
  } as any, { sessionId: 'track-race', text: 'hello' } as any);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not-found');
  assert.equal(sends, 0);
});

test('sessions.send accepts after touchForUse and a later sweep can select the session again', async () => {
  const repo = await makeRepo();
  await repo.registerSession('cortex-touch', registerOpts('track-touch'));
  await repo.updateSession('cortex-touch', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  const touched: string[] = [];
  const sendResult = await handleSendSession({
    sessionStore: {
      getById: async () => ({ sessionId: 'track-touch', channel: 'web:track-touch', kind: 'local' }),
      touchForUse: async (sessionId: string) => { touched.push(sessionId); return repo.touchForUse(sessionId); },
      listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [],
    },
    sendSessionMessage: () => {},
  } as any, { sessionId: 'track-touch', text: 'hello' } as any);

  const sweepResult = await repo.beginDeleteExpired(new Date('2100-01-01T00:00:00.000Z'), []);
  assert.deepEqual(touched, ['track-touch']);
  assert.deepEqual(sendResult, { ok: true, data: { accepted: true } });
  assert.deepEqual(sweepResult.map((entry) => entry.session.sessionId), ['track-touch']);
});
