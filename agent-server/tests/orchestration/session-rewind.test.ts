import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { rewindWebSession, type RewindDeps } from '../../src/orchestration/session-rewind.js';
import { transcriptCutter } from '../../src/orchestration/rewind-restore.js';
import type { TurnAnchor } from '../../src/core/types/transcript-anchor.js';
import type { PlatformAdapter } from '../../src/platform/index.js';

const adapter = {} as PlatformAdapter;
const CLAUDE_FILE = '/projects/-w/backend-1.jsonl';

interface CallLog { calls: string[] }

function turn(turnIndex: number, text: string, anchor?: TurnAnchor) {
  return {
    turnIndex, userMessageTs: `ts${turnIndex}`, userMessageText: text, statusMessageTs: null,
    responseMessageTimestamps: [], executionId: null, backupPath: null,
    ...(anchor ? { anchor } : {}),
    status: 'completed' as const, createdAt: '', updatedAt: '',
  };
}

function makeConversation(turn1Anchor: TurnAnchor | null = { file: CLAUDE_FILE, after: 'e1' }) {
  return {
    sessionId: 'track-1', backend: 'claude', selection: null,
    turns: [turn(0, 'first'), turn(1, 'orig text', turn1Anchor ?? undefined)],
    updatedAt: '',
  };
}

function anchorId(anchor: TurnAnchor): string {
  return 'after' in anchor ? anchor.after : anchor.before;
}

function makeCutter(log: CallLog, opts: { resolves?: boolean; truncates?: boolean } = {}): RewindDeps['transcript'] {
  return {
    resolves: async (a) => { log.calls.push(`resolves:${a.file}:${anchorId(a)}`); return opts.resolves ?? true; },
    truncate: async (a) => { log.calls.push(`truncate:${a.file}:${anchorId(a)}`); return opts.truncates ?? true; },
  };
}

function makeLedgerDeps(log: CallLog, conversation = makeConversation()): RewindDeps['ledger'] {
  return {
    getConversation: async () => conversation,
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

function makeSessionStoreDeps(log: CallLog, backendSessionId: string | null = 'backend-1'): RewindDeps['sessionStore'] {
  return {
    getById: async () => ({
      sessionId: 'track-1', backendSessionId,
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
    transcript: makeCutter(log),
    resolveBackend: () => 'claude',
    registerPISessionPath: (id, file) => { log.calls.push(`registerPI:${id}:${file}`); },
    closePooledSession: (ch, backend) => { log.calls.push(`closePooled:${ch}:${backend}`); },
    send: (opts) => {
      log.calls.push(`send:${opts.channel}:${opts.text}:${opts.attachments?.length ?? 0}`);
      opts.mutationRelease?.();
    },
    publishRewound: (p) => { log.calls.push(`rewound:${p.sessionId}:${p.turnIndex}`); },
    ...overrides,
  };
}

function rewind(deps: RewindDeps, turnIndex = 1, text = 'edited text') {
  return rewindWebSession({ sessionId: 'track-1', channel: 'web:track-1', turnIndex, text, adapter }, deps);
}

test('rejects when the channel has a live run (edit is disabled while running)', async () => {
  const log: CallLog = { calls: [] };
  const res = await rewind(makeDeps(log, { activeAgents: { hasChannel: () => true } }));
  assert.deepEqual(res, { ok: false, reason: 'running' });
  assert.equal(log.calls.length, 0, 'nothing was touched');
});

test('rejects while the turn is still being recorded', async () => {
  const log: CallLog = { calls: [] };
  const res = await rewind(makeDeps(log, { snapshotPending: () => true }));
  assert.deepEqual(res, { ok: false, reason: 'running' });
  assert.equal(log.calls.length, 0, 'rewind cannot race an incomplete turn record');
});

test('holds the turn mutation lock through rewind validation', async () => {
  const log: CallLog = { calls: [] };
  let releaseCount = 0;
  let resolveConversation!: (value: null) => void;
  const conversation = new Promise<null>((resolve) => { resolveConversation = resolve; });
  const deps = makeDeps(log, {
    tryAcquireMutation: () => () => { releaseCount++; },
    ledger: { ...makeLedgerDeps(log), getConversation: async () => conversation },
  });

  const attempt = rewind(deps);
  await Promise.resolve();
  assert.equal(releaseCount, 0);
  resolveConversation(null);
  assert.deepEqual(await attempt, { ok: false, reason: 'not-found' });
  assert.equal(releaseCount, 1);
});

test('rejects when the ledger has no conversation or the turn is out of range', async () => {
  const log: CallLog = { calls: [] };
  const noConv = makeDeps(log, { ledger: { ...makeLedgerDeps(log), getConversation: async () => null } });
  assert.deepEqual(await rewind(noConv, 0, 'x'), { ok: false, reason: 'not-found' });
  assert.deepEqual(await rewind(makeDeps(log), 2, 'x'), { ok: false, reason: 'not-found' });
  assert.ok(!log.calls.some(c => c.startsWith('rollbackTo')), 'no rollback on rejection');
});

test('happy path (turn ≥ 1, claude): plan → rollback → cut transcript → close pool → truncate → history → marker → publish → resend', async () => {
  const log: CallLog = { calls: [] };
  assert.deepEqual(await rewind(makeDeps(log)), { ok: true });
  assert.deepEqual(log.calls, [
    `resolves:${CLAUDE_FILE}:e1`,
    'rollbackTo:web:track-1:1',
    `truncate:${CLAUDE_FILE}:e1`,
    'closePooled:web:track-1:claude',
    'truncateTurns:web:track-1:1',
    'historyTruncate:track-1:1',
    'marker:track-1:orig text',
    'rewound:track-1:1',
    'send:web:track-1:edited text:1',
  ]);
});

test('turn 0 starts a fresh backend session (track id kept), cutting nothing', async () => {
  const log: CallLog = { calls: [] };
  assert.deepEqual(await rewind(makeDeps(log), 0, 'redo'), { ok: true });
  assert.ok(!log.calls.some(c => c.startsWith('truncate:') || c.startsWith('resolves:')));
  assert.ok(log.calls.includes('updateSession:track-1:{"backendSessionId":null}'), 'backend id cleared');
  assert.ok(log.calls.includes('closePooled:web:track-1:claude'));
  assert.ok(log.calls.some(c => c.startsWith('send:web:track-1:redo')));
});

test('a turn with no anchor (a message injected mid-run before anchors existed) is refused untouched', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, { ledger: makeLedgerDeps(log, makeConversation(null)) });
  assert.deepEqual(await rewind(deps), { ok: false, reason: 'no-restore-point' });
  assert.deepEqual(log.calls, [], 'no rollback, no fresh backend session, no resend');
});

test('an anchor in another backend session\'s transcript is refused untouched', async () => {
  const log: CallLog = { calls: [] };
  const conv = makeConversation({ file: '/projects/-w/backend-old.jsonl', before: 'u5' });
  const deps = makeDeps(log, { ledger: makeLedgerDeps(log, conv) });
  assert.deepEqual(await rewind(deps), { ok: false, reason: 'no-restore-point' });
  assert.deepEqual(log.calls, []);
});

test('an anchor whose entry is gone from the transcript is refused untouched', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, { transcript: makeCutter(log, { resolves: false }) });
  assert.deepEqual(await rewind(deps), { ok: false, reason: 'no-restore-point' });
  assert.deepEqual(log.calls, [`resolves:${CLAUDE_FILE}:e1`]);
});

test('a session the backend never opened rewinds to a fresh session', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, { sessionStore: makeSessionStoreDeps(log, null) });
  assert.deepEqual(await rewind(deps), { ok: true });
  assert.ok(log.calls.includes('updateSession:track-1:{"backendSessionId":null}'));
  assert.ok(!log.calls.some(c => c.startsWith('truncate:')));
});

test('a transcript that changed between planning and cutting falls back to a fresh session', async () => {
  const log: CallLog = { calls: [] };
  const deps = makeDeps(log, { transcript: makeCutter(log, { truncates: false }) });
  assert.deepEqual(await rewind(deps), { ok: true });
  assert.ok(log.calls.includes('updateSession:track-1:{"backendSessionId":null}'));
});

interface PIRewindFixture {
  sessionDir: string;
  source: string;
  canonical: string;
  piAdapter: PIAdapter;
}

const PI_LINES = [
  { type: 'session', id: 'backend-1' },
  { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'first' } },
  { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: 'reply' } },
  { type: 'message', id: 'e3', parentId: 'e2', message: { role: 'user', content: 'orig text' } },
  { type: 'message', id: 'e4', parentId: 'e3', message: { role: 'assistant', content: 'reply 2' } },
].map((row) => `${JSON.stringify(row)}\n`);

function stagePIRewindFixture(): PIRewindFixture {
  const sessionDir = pathJoin(tmpdir(), `web-rewind-pi-${process.pid}-${Date.now()}`);
  const source = pathJoin(sessionDir, '2026-08-01T00-00-00Z_backend-1.jsonl');
  const canonical = pathJoin(sessionDir, 'backend-1.jsonl');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(source, PI_LINES.join(''));
  writeFileSync(canonical, 'selector-preferred-context');
  return { sessionDir, source, canonical, piAdapter: new PIAdapter(undefined, sessionDir) };
}

test('PI rewind cuts the anchored transcript and resends from it even when a canonical duplicate exists', async () => {
  const log: CallLog = { calls: [] };
  const fixture = stagePIRewindFixture();
  let resendPath: string | null = null;
  const conv = makeConversation({ file: fixture.source, after: 'e2' });
  conv.backend = 'pi';
  const deps = makeDeps(log, {
    resolveBackend: () => 'pi',
    ledger: makeLedgerDeps(log, conv),
    transcript: transcriptCutter,
    registerPISessionPath: (sessionId, filePath) => {
      log.calls.push(`registerPI:${sessionId}:${filePath}`);
      fixture.piAdapter.registerSessionPath(sessionId, filePath);
    },
    send: (opts) => {
      resendPath = fixture.piAdapter.resolveSessionPath('backend-1');
      opts.mutationRelease?.();
    },
  });
  try {
    assert.deepEqual(await rewind(deps, 1, 'edited'), { ok: true });
    assert.equal(readFileSync(fixture.source, 'utf8'), PI_LINES.slice(0, 3).join(''));
    assert.equal(readFileSync(fixture.canonical, 'utf8'), 'selector-preferred-context');
    assert.equal(resendPath, fixture.source);
    assert.ok(log.calls.includes(`registerPI:backend-1:${fixture.source}`));
    assert.ok(!log.calls.some(c => c.startsWith('updateSession:')), 'the backend session is kept');
  } finally {
    rmSync(fixture.sessionDir, { recursive: true, force: true });
  }
});

test('integration: real ledger + history + session registry round-trip (isolated CORTEX_HOME)', async () => {
  const { conversationLedger } = await import('../../src/store/conversation-ledger-repo.js');
  const { conversationHistory } = await import('../../src/store/conversation-history-repo.js');
  const { sessionStore } = await import('../../src/store/session-registry-repo.js');

  const sid = 'track-int-1';
  const channel = `web:${sid}`;
  await sessionStore.registerSession({
    sessionId: sid, channel, backend: 'claude', kind: 'local', backendSessionId: 'backend-int-1',
  });
  for (const [i, msg] of (['first', 'second'] as const).entries()) {
    await conversationLedger.initAndBeginTurn(channel, {
      sessionId: sid, backend: 'claude',
      userMessageTs: `ts${i}`, userMessageText: msg, statusMessageTs: `st${i}`,
      anchor: { file: '/projects/-w/backend-int-1.jsonl', after: `e${i}` },
    });
    await conversationHistory.appendUser(sid, { text: msg });
    await conversationHistory.appendAssistant(sid, { text: `reply-${i}` });
  }

  const log: CallLog = { calls: [] };
  const res = await rewindWebSession(
    { sessionId: sid, channel, turnIndex: 1, text: 'second (edited)', adapter },
    { ...makeDeps(log), ledger: conversationLedger, history: conversationHistory, sessionStore },
  );
  assert.deepEqual(res, { ok: true });

  // History rewound to turn 0 only (the dangling marker is invisible until the resend appends).
  const h = await conversationHistory.getHistory(sid);
  assert.deepEqual(h!.events.map(e => `${e.type}:${e.text}`), ['user:first', 'assistant:reply-0']);

  // Ledger truncated to one turn.
  const conv = await conversationLedger.getConversation(channel);
  assert.equal(conv!.turns.length, 1);
  assert.equal(conv!.turns[0].userMessageText, 'first');

  // The transcript was cut at the edited turn's own anchor; the edited text was re-sent.
  assert.ok(log.calls.includes('truncate:/projects/-w/backend-int-1.jsonl:e1'));
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
