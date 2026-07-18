import '../_test-home.js'; // MUST be first — repoints CORTEX_HOME before paths bind
// input:  src/orchestration/session-rewind.js
// output: Unit tests — channel-agnostic message edit + rewind for web sessions
// pos:    Guards the web rewind orchestration (ledger rollback + backup restore + history truncate + resend)

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { rewindWebSession, type RewindDeps } from '../../src/orchestration/session-rewind.js';
import type { PlatformAdapter } from '../../src/platform/index.js';

const adapter = {} as PlatformAdapter;

interface CallLog { calls: string[] }

function makeDeps(log: CallLog, overrides: Partial<RewindDeps> = {}): RewindDeps {
  const removedUser = { text: 'orig text', ts: '2026-07-17T00:00:00.000Z', attachments: [{ name: 'a.png', path: 'p', size: 1, mimeType: 'image/png', type: 'image' as const }] };
  return {
    activeAgents: { hasChannel: () => false },
    ledger: {
      getConversation: async () => ({
        sessionId: 'track-1', sessionName: 'cortex-1', backend: 'claude', profileName: null,
        turns: [
          { turnIndex: 0, userMessageTs: 'ts0', userMessageText: 'first', statusMessageTs: null, responseMessageTimestamps: [], executionId: null, backupPath: null, status: 'completed' as const, createdAt: '', updatedAt: '' },
          { turnIndex: 1, userMessageTs: 'ts1', userMessageText: 'orig text', statusMessageTs: null, responseMessageTimestamps: [], executionId: null, backupPath: null, status: 'completed' as const, createdAt: '', updatedAt: '' },
        ],
        updatedAt: '',
      }),
      rollbackTo: async (ch, i) => { log.calls.push(`rollbackTo:${ch}:${i}`); return { supersededTurns: [], conversation: {} as any }; },
      truncateTurns: async (ch, i) => { log.calls.push(`truncateTurns:${ch}:${i}`); },
    },
    history: {
      truncateFromTurn: async (sid, i) => { log.calls.push(`historyTruncate:${sid}:${i}`); return removedUser; },
      appendEditMarker: async (sid, m) => { log.calls.push(`marker:${sid}:${m.originalText}`); },
    },
    sessionStore: {
      getById: async () => ({ name: 'cortex-1', sessionId: 'track-1', backendSessionId: 'backend-1', channel: 'web:track-1', backend: 'claude' } as any),
      updateSession: async (name, updates) => { log.calls.push(`updateSession:${name}:${JSON.stringify(updates)}`); },
    },
    backup: {
      restoreBackup: (sid, i) => { log.calls.push(`restoreBackup:${sid}:${i}`); return true; },
      cleanupBackupsAfter: (sid, i) => { log.calls.push(`cleanupAfter:${sid}:${i}`); },
      cleanupAllBackups: (sid) => { log.calls.push(`cleanupAll:${sid}`); },
      findPISessionFile: () => null,
      restoreSessionFile: () => false,
      cleanupBackupsForFile: () => {},
    },
    resolveBackend: () => 'claude',
    closePooledSession: (ch, backend) => { log.calls.push(`closePooled:${ch}:${backend}`); },
    send: (opts) => { log.calls.push(`send:${opts.channel}:${opts.text}:${opts.attachments?.length ?? 0}`); },
    publishRewound: (p) => { log.calls.push(`rewound:${p.sessionId}:${p.turnIndex}`); },
    ...overrides,
  };
}

test('rejects when the channel has a live run (edit is disabled while running)', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, { activeAgents: { hasChannel: () => true } });
  const res = await rewindWebSession({ sessionId: 'track-1', channel: 'web:track-1', turnIndex: 1, text: 'new', adapter }, deps);
  assert.deepEqual(res, { ok: false, reason: 'running' });
  assert.equal(log.calls.length, 0, 'nothing was touched');
});

test('rejects when the ledger has no conversation or the turn is out of range', async () => {
  const log: CallLog = { calls: [] };
  const noConv = makeDeps(log, { ledger: { ...makeDeps(log).ledger, getConversation: async () => null } });
  assert.deepEqual(await rewindWebSession({ sessionId: 's', channel: 'c', turnIndex: 0, text: 'x', adapter }, noConv), { ok: false, reason: 'not-found' });

  const outOfRange = makeDeps(log);
  assert.deepEqual(await rewindWebSession({ sessionId: 's', channel: 'c', turnIndex: 2, text: 'x', adapter }, outOfRange), { ok: false, reason: 'not-found' });
  assert.ok(!log.calls.some(c => c.startsWith('rollbackTo')), 'no rollback on rejection');
});

test('happy path (turn ≥ 1, claude, backup exists): rollback → restore → close pool → truncate → history → marker → publish → resend with original attachments', async () => {
  const log: CallLog = { calls: [] };
  const res = await rewindWebSession({ sessionId: 'track-1', channel: 'web:track-1', turnIndex: 1, text: 'edited text', adapter }, makeDeps(log));
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(log.calls, [
    'rollbackTo:web:track-1:1',
    'restoreBackup:backend-1:1',
    'closePooled:web:track-1:claude',
    'truncateTurns:web:track-1:1',
    'cleanupAfter:backend-1:1',
    'historyTruncate:track-1:1',
    'marker:track-1:orig text',
    'rewound:track-1:1',
    'send:web:track-1:edited text:1',
  ]);
});

test('turn 0: no backup restore — backend session id is cleared (fresh backend session, track id kept)', async () => {
  const log: CallLog = { calls: [] };
  const res = await rewindWebSession({ sessionId: 'track-1', channel: 'web:track-1', turnIndex: 0, text: 'redo', adapter }, makeDeps(log));
  assert.deepEqual(res, { ok: true });
  assert.ok(!log.calls.some(c => c.startsWith('restoreBackup')), 'no restore for turn 0');
  assert.ok(log.calls.includes('updateSession:cortex-1:{"backendSessionId":null}'), 'backend id cleared');
  assert.ok(log.calls.includes('cleanupAll:backend-1'), 'all backups cleaned');
  assert.ok(log.calls.includes('closePooled:web:track-1:claude'));
  assert.ok(log.calls.some(c => c.startsWith('send:web:track-1:redo')));
});

test('missing backup on turn ≥ 1 falls back to clearing the backend session id', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, {
    backup: { ...makeDeps({ calls: [] }).backup, restoreBackup: (sid, i) => { log.calls.push(`restoreBackup:${sid}:${i}`); return false; }, cleanupAllBackups: (sid) => { log.calls.push(`cleanupAll:${sid}`); } },
  });
  const res = await rewindWebSession({ sessionId: 'track-1', channel: 'web:track-1', turnIndex: 1, text: 'edited', adapter }, deps);
  assert.deepEqual(res, { ok: true });
  assert.ok(log.calls.includes('updateSession:cortex-1:{"backendSessionId":null}'), 'fallback clears backend id');
});

test('missing session record → not-found', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, { sessionStore: { getById: async () => null, updateSession: async () => {} } });
  assert.deepEqual(await rewindWebSession({ sessionId: 'ghost', channel: 'c', turnIndex: 0, text: 'x', adapter }, deps), { ok: false, reason: 'not-found' });
});
