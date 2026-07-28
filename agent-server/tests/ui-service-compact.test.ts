// input:  sessions compact mutate handler with fake store/coordinator
// output: success, not-found, busy, unsupported, and unwired mappings
// pos:    UI-service manual context compact mutation tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleCompactSession } from '../src/domain/ui-service/mutate/sessions.js';

const SESSION = { sessionId: 'track-1', channel: 'web:track-1' };

function deps(outcome: any = { ok: true, status: 'compacted', contextUsage: null }): any {
  return {
    sessionStore: { getById: async () => SESSION },
    compactSession: async () => outcome,
  };
}

test('sessions.compact returns the shared coordinator success payload', async () => {
  const result = await handleCompactSession(deps(), { sessionId: 'track-1' });
  assert.deepEqual(result, { ok: true, data: { status: 'compacted', contextUsage: null } });
});

test('sessions.compact maps missing session and unwired coordinator', async () => {
  const missing = await handleCompactSession({ sessionStore: { getById: async () => null } } as any, { sessionId: 'ghost' });
  assert.deepEqual(missing, { ok: false, code: 'not-found', message: 'Session not found: ghost' });

  const unwired = await handleCompactSession({ sessionStore: { getById: async () => SESSION } } as any, { sessionId: 'track-1' });
  assert.deepEqual(unwired, { ok: false, code: 'not-available', message: 'Session compaction is not available' });
});

test('sessions.compact maps coordinator busy and unsupported outcomes', async () => {
  const busy = await handleCompactSession(deps({ ok: false, reason: 'running' }), { sessionId: 'track-1' });
  assert.deepEqual(busy, {
    ok: false, code: 'session-running',
    message: 'Session is running — stop it before compacting context',
  });
  const unsupported = await handleCompactSession(deps({ ok: false, reason: 'unsupported' }), { sessionId: 'track-1' });
  assert.deepEqual(unsupported, {
    ok: false, code: 'not-available',
    message: 'This session backend does not support manual context compaction',
  });
});
