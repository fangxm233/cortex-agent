// input:  web rewinds, PI path registry, async backups
// output: exact restore, cleanup and resend regressions
// pos:    Verifies web session rewind orchestration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import '../_test-home.js';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import * as realSessionBackup from '../../src/domain/sessions/session-backup.js';
import { rewindWebSession, type RewindDeps } from '../../src/orchestration/session-rewind.js';
import type { PlatformAdapter } from '../../src/platform/index.js';

const adapter = {} as PlatformAdapter;

interface CallLog { calls: string[] }

function makeConversation() {
  return {
    sessionId: 'track-1', sessionName: 'cortex-1', backend: 'claude', profileName: null,
    turns: [
      { turnIndex: 0, userMessageTs: 'ts0', userMessageText: 'first', statusMessageTs: null, responseMessageTimestamps: [], executionId: null, backupPath: null, status: 'completed' as const, createdAt: '', updatedAt: '' },
      { turnIndex: 1, userMessageTs: 'ts1', userMessageText: 'orig text', statusMessageTs: null, responseMessageTimestamps: [], executionId: null, backupPath: null, status: 'completed' as const, createdAt: '', updatedAt: '' },
    ],
    updatedAt: '',
  };
}

function makeBackupDeps(log: CallLog): RewindDeps['backup'] {
  return {
    restoreBackup: async (sid, i) => { log.calls.push(`restoreBackup:${sid}:${i}`); return true; },
    cleanupBackupsAfter: (sid, i) => { log.calls.push(`cleanupAfter:${sid}:${i}`); },
    cleanupAllBackups: (sid) => { log.calls.push(`cleanupAll:${sid}`); },
    findPISessionFile: async () => null,
    restoreSessionFile: async () => false,
    restoreSessionBackup: async () => false,
    sessionFileFromBackupPath: () => null,
    cleanupBackupsForFile: () => {},
    cleanupAllBackupsForFile: () => {},
  };
}

function makeLedgerDeps(log: CallLog): RewindDeps['ledger'] {
  return {
    getConversation: async () => makeConversation(),
    rollbackTo: async (ch, i) => {
      log.calls.push(`rollbackTo:${ch}:${i}`);
      return { supersededTurns: [], conversation: {} as any };
    },
    truncateTurns: async (ch, i) => { log.calls.push(`truncateTurns:${ch}:${i}`); },
  };
}

function makeHistoryDeps(log: CallLog): RewindDeps['history'] {
  const removed = { text: 'orig text', ts: '2026-07-17T00:00:00.000Z', attachments: [{ name: 'a.png', path: 'p', size: 1, mimeType: 'image/png', type: 'image' as const }] };
  return {
    truncateFromTurn: async (sid, i) => { log.calls.push(`historyTruncate:${sid}:${i}`); return removed; },
    appendEditMarker: async (sid, marker) => { log.calls.push(`marker:${sid}:${marker.originalText}`); },
  };
}

function makeSessionStoreDeps(log: CallLog): RewindDeps['sessionStore'] {
  return {
    getById: async () => ({
      name: 'cortex-1', sessionId: 'track-1', backendSessionId: 'backend-1',
      channel: 'web:track-1', backend: 'claude',
    } as any),
    updateSession: async (name, updates) => {
      log.calls.push(`updateSession:${name}:${JSON.stringify(updates)}`);
    },
  };
}

function makeDeps(log: CallLog, overrides: Partial<RewindDeps> = {}): RewindDeps {
  return {
    activeAgents: { hasChannel: () => false },
    snapshotPending: () => false,
    tryAcquireMutation: () => () => {},
    ledger: makeLedgerDeps(log),
    history: makeHistoryDeps(log),
    sessionStore: makeSessionStoreDeps(log),
    backup: makeBackupDeps(log),
    resolveBackend: () => 'claude',
    registerPISessionPath: () => {},
    closePooledSession: (ch, backend) => { log.calls.push(`closePooled:${ch}:${backend}`); },
    send: (opts) => {
      log.calls.push(`send:${opts.channel}:${opts.text}:${opts.attachments?.length ?? 0}`);
      opts.mutationRelease?.();
    },
    publishRewound: (p) => { log.calls.push(`rewound:${p.sessionId}:${p.turnIndex}`); },
    ...overrides,
  };
}

interface PIRewindFixture {
  sessionDir: string;
  source: string;
  canonical: string;
  backupPath: string;
  piAdapter: PIAdapter;
}

function stagePIRewindFixture(): PIRewindFixture {
  const sessionDir = pathJoin(tmpdir(), `web-rewind-pi-${process.pid}-${Date.now()}`);
  const source = pathJoin(sessionDir, '2026-08-01T00-00-00Z_backend-1.jsonl');
  const canonical = pathJoin(sessionDir, 'backend-1.jsonl');
  const backupPath = `${source}.turn-1.bak`;
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(source, 'after-turn');
  writeFileSync(backupPath, 'restored-context');
  writeFileSync(canonical, 'selector-preferred-context');
  return { sessionDir, source, canonical, backupPath, piAdapter: new PIAdapter(undefined, sessionDir) };
}

function makeRecordedPIBackup(log: CallLog, fixture: PIRewindFixture): RewindDeps['backup'] {
  return {
    ...makeBackupDeps(log),
    findPISessionFile: async () => { log.calls.push('findPI:canonical'); return fixture.canonical; },
    sessionFileFromBackupPath: realSessionBackup.sessionFileFromBackupPath,
    restoreSessionBackup: realSessionBackup.restoreSessionBackup,
    cleanupBackupsForFile: (filePath, turnIndex) => {
      log.calls.push(`cleanupForFile:${filePath}:${turnIndex}`);
    },
  };
}

async function makeRecordedPIRewindDeps(
  log: CallLog,
  fixture: PIRewindFixture,
  run: { resendPath: string | null },
): Promise<RewindDeps> {
  const base = makeDeps(log);
  const conversation = await base.ledger.getConversation('web:track-1');
  conversation!.backend = 'pi';
  conversation!.turns[1].backupPath = fixture.backupPath;
  return makeDeps(log, {
    resolveBackend: () => 'pi',
    ledger: { ...base.ledger, getConversation: async () => conversation },
    backup: makeRecordedPIBackup(log, fixture),
    registerPISessionPath: (sessionId, filePath) => {
      log.calls.push(`registerPI:${sessionId}:${filePath}`);
      fixture.piAdapter.registerSessionPath(sessionId, filePath);
    },
    send: (opts) => {
      run.resendPath = fixture.piAdapter.resolveSessionPath('backend-1');
      log.calls.push(`send:${opts.channel}:${opts.text}`);
      opts.mutationRelease?.();
    },
  });
}

async function makeFailedPIRewindDeps(log: CallLog, source: string): Promise<RewindDeps> {
  const base = makeDeps(log);
  const conversation = await base.ledger.getConversation('web:track-1');
  conversation!.backend = 'pi';
  conversation!.turns[1].backupPath = `${source}.turn-1.bak`;
  return makeDeps(log, {
    resolveBackend: () => 'pi',
    ledger: { ...base.ledger, getConversation: async () => conversation },
    backup: {
      ...base.backup,
      sessionFileFromBackupPath: () => source,
      restoreSessionBackup: async () => false,
      cleanupAllBackupsForFile: (filePath) => { log.calls.push(`cleanupAllForFile:${filePath}`); },
    },
    registerPISessionPath: (sessionId, filePath) => {
      log.calls.push(`registerPI:${sessionId}:${filePath}`);
    },
  });
}

test('rejects when the channel has a live run (edit is disabled while running)', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, { activeAgents: { hasChannel: () => true } });
  const res = await rewindWebSession({ sessionId: 'track-1', channel: 'web:track-1', turnIndex: 1, text: 'new', adapter }, deps);
  assert.deepEqual(res, { ok: false, reason: 'running' });
  assert.equal(log.calls.length, 0, 'nothing was touched');
});

test('rejects while the pre-turn snapshot is pending', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, { snapshotPending: () => true });
  const res = await rewindWebSession({ sessionId: 'track-1', channel: 'web:track-1', turnIndex: 1, text: 'new', adapter }, deps);
  assert.deepEqual(res, { ok: false, reason: 'running' });
  assert.equal(log.calls.length, 0, 'rewind cannot race an incomplete snapshot');
});

test('holds the turn mutation lock through rewind validation', async () => {
  const log: CallLog = { calls: [] };
  let releaseCount = 0;
  let resolveConversation!: (value: null) => void;
  const conversation = new Promise<null>((resolve) => { resolveConversation = resolve; });
  const base = makeDeps(log);
  const deps = makeDeps(log, {
    tryAcquireMutation: () => () => { releaseCount++; },
    ledger: { ...base.ledger, getConversation: async () => conversation },
  });

  const attempt = rewindWebSession({ sessionId: 'track-1', channel: 'web:track-1', turnIndex: 1, text: 'new', adapter }, deps);
  await Promise.resolve();
  assert.equal(releaseCount, 0);
  resolveConversation(null);
  assert.deepEqual(await attempt, { ok: false, reason: 'not-found' });
  assert.equal(releaseCount, 1);
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
    backup: { ...makeDeps({ calls: [] }).backup, restoreBackup: async (sid, i) => { log.calls.push(`restoreBackup:${sid}:${i}`); return false; }, cleanupAllBackups: (sid) => { log.calls.push(`cleanupAll:${sid}`); } },
  });
  const res = await rewindWebSession({ sessionId: 'track-1', channel: 'web:track-1', turnIndex: 1, text: 'edited', adapter }, deps);
  assert.deepEqual(res, { ok: true });
  assert.ok(log.calls.includes('updateSession:cortex-1:{"backendSessionId":null}'), 'fallback clears backend id');
});

test('PI rewind resends from the recorded restored path when an empty registry would prefer a canonical duplicate', async () => {
  const log: CallLog = { calls: [] };
  const fixture = stagePIRewindFixture();
  const run = { resendPath: null as string | null };
  const deps = await makeRecordedPIRewindDeps(log, fixture, run);
  try {
    const result = await rewindWebSession(
      { sessionId: 'track-1', channel: 'web:track-1', turnIndex: 1, text: 'edited', adapter }, deps,
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(readFileSync(fixture.source, 'utf8'), 'restored-context');
    assert.equal(readFileSync(fixture.canonical, 'utf8'), 'selector-preferred-context');
    assert.equal(run.resendPath, fixture.source);
    assert.ok(log.calls.includes(`registerPI:backend-1:${fixture.source}`));
    assert.ok(!log.calls.includes('findPI:canonical'));
  } finally {
    rmSync(fixture.sessionDir, { recursive: true, force: true });
  }
});

test('failed PI rewind cleans every backup beside the recorded session file', async () => {
  const log: CallLog = { calls: [] };
  const source = '/sessions/2026-08-01_backend-1.jsonl';
  const deps = await makeFailedPIRewindDeps(log, source);
  const result = await rewindWebSession(
    { sessionId: 'track-1', channel: 'web:track-1', turnIndex: 1, text: 'edited', adapter }, deps,
  );
  assert.deepEqual(result, { ok: true });
  assert.ok(log.calls.includes(`cleanupAllForFile:${source}`));
  assert.ok(!log.calls.some((call) => call.startsWith('registerPI:')));
  assert.ok(!log.calls.includes('cleanupAll:backend-1'));
});

test('integration: real ledger + history + session registry round-trip (isolated CORTEX_HOME)', async () => {
  const { conversationLedger } = await import('../../src/store/conversation-ledger-repo.js');
  const { conversationHistory } = await import('../../src/store/conversation-history-repo.js');
  const { sessionStore } = await import('../../src/store/session-registry-repo.js');

  const sid = 'track-int-1';
  const channel = `web:${sid}`;
  await sessionStore.registerSession('cortex-int1', {
    sessionId: sid, channel, backend: 'claude', kind: 'local', backendSessionId: 'backend-int-1',
  });
  for (const [i, msg] of (['first', 'second'] as const).entries()) {
    await conversationLedger.initAndBeginTurn(channel, {
      sessionId: sid, sessionName: 'cortex-int1', backend: 'claude',
      userMessageTs: `ts${i}`, userMessageText: msg, statusMessageTs: `st${i}`,
    });
    await conversationHistory.appendUser(sid, { text: msg });
    await conversationHistory.appendAssistant(sid, { text: `reply-${i}` });
  }

  const log: CallLog = { calls: [] };
  const res = await rewindWebSession(
    { sessionId: sid, channel, turnIndex: 1, text: 'second (edited)', adapter },
    {
      ...makeDeps(log),
      ledger: conversationLedger,
      history: conversationHistory,
      sessionStore,
    },
  );
  assert.deepEqual(res, { ok: true });

  // History rewound to turn 0 only (the dangling marker is invisible until the resend appends).
  const h = await conversationHistory.getHistory(sid);
  assert.deepEqual(h!.events.map(e => `${e.type}:${e.text}`), ['user:first', 'assistant:reply-0']);

  // Ledger truncated to one turn.
  const conv = await conversationLedger.getConversation(channel);
  assert.equal(conv!.turns.length, 1);
  assert.equal(conv!.turns[0].userMessageText, 'first');

  // The edited text was re-sent; the marker carries the REAL original text.
  assert.ok(log.calls.includes('restoreBackup:backend-int-1:1'), 'backup restored for the real backend id');
  assert.ok(log.calls.some(c => c.startsWith('send:web:track-int-1:second (edited)')));

  // A resend would append the new user event — simulate it and confirm the edited marker merges.
  await conversationHistory.appendUser(sid, { text: 'second (edited)' });
  const h2 = await conversationHistory.getHistory(sid);
  const user1 = h2!.events.filter(e => e.type === 'user')[1];
  assert.equal(user1.edited?.originalText, 'second');
});

test('missing session record → not-found', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, { sessionStore: { getById: async () => null, updateSession: async () => {} } });
  assert.deepEqual(await rewindWebSession({ sessionId: 'ghost', channel: 'c', turnIndex: 0, text: 'x', adapter }, deps), { ok: false, reason: 'not-found' });
});
