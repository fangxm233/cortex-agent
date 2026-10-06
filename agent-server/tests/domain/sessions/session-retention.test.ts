import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo, sessionStore, type Session, type SessionRegistryRepoOptions } from '../../../src/store/session-registry-repo.js';
import { acquireSessionUse } from '../../../src/domain/sessions/session-use.js';
import { ConversationLedgerRepo } from '../../../src/store/conversation-ledger-repo.js';
import { ConversationHistoryRepo } from '../../../src/store/conversation-history-repo.js';
import { RetentionCandidateRepo } from '../../../src/store/retention-candidate-repo.js';
import { runSessionRetentionSweep } from '../../../src/domain/sessions/session-retention.js';
import { SessionTotalsCarryRepo } from '../../../src/store/session-totals-repo.js';
import { buildSessionRetentionLiveness } from '../../../src/orchestration/session-retention-liveness.js';

function registerOpts(id: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: id,
    channel: `web:${id}`,
    backend: 'claude',
    kind: 'local' as const,
    projectId: 'proj',
    label: 'label',
    ...extra,
  };
}

async function makeHarness(registryOptions: SessionRegistryRepoOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-retention-'));
  const storeDir = path.join(root, 'store');
  const historyDir = path.join(root, 'conversation-history');
  const piDir = path.join(root, 'sessions-pi');
  const captureDir = path.join(root, 'logs', 'sessions');
  const claudeProjectDir = path.join(root, '.claude', 'projects', 'cortex-home');
  await Promise.all([
    fs.mkdir(storeDir, { recursive: true }),
    fs.mkdir(historyDir, { recursive: true }),
    fs.mkdir(piDir, { recursive: true }),
    fs.mkdir(captureDir, { recursive: true }),
    fs.mkdir(claudeProjectDir, { recursive: true }),
  ]);
  // One registry owns identity now; the ledger is a façade over the same registry (as production
  // wires conversationLedger onto sessionStore).
  const registry = new SessionRegistryRepo(path.join(storeDir, 'session-registry.jsonl'), registryOptions);
  return {
    root,
    storeDir,
    historyDir,
    piDir,
    captureDir,
    claudeProjectDir,
    registry,
    ledger: new ConversationLedgerRepo(registry),
    history: new ConversationHistoryRepo(historyDir),
    candidates: new RetentionCandidateRepo(path.join(storeDir, 'retention-candidates.json')),
  };
}

test('retention sweep retries pending intents, does not commit failed cleanup, then retries successfully', async () => {
  const h = await makeHarness();
  await h.registry.registerSession('cortex-old', registerOpts('track-old', { backendSessionId: 'backend-old' }));
  await h.registry.updateSession('cortex-old', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await h.registry.bindChannel('web:track-old', 'track-old');
  await h.ledger.initConversation('web:track-old', {
    sessionId: 'track-old', sessionName: 'cortex-old', backend: 'claude',
  });
  await h.history.appendUser('track-old', { text: 'old' });
  await h.ledger.beginTurn('web:track-old', {
    userMessageTs: 'M1', userMessageText: 'old',
  });
  const backupPath = path.join(h.claudeProjectDir, 'backend-old.jsonl.turn-0.bak');
  await fs.writeFile(backupPath, 'backup\n');
  await h.ledger.setBackupPath('web:track-old', 'M1', backupPath);

  let failHistory = true;
  const first = await runSessionRetentionSweep({
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry,
    ledgerRepo: h.ledger,
    historyRepo: {
      ...h.history,
      clearBySessionIds: async (sessionIds: Iterable<string>) => {
        if (failHistory) throw new Error(`boom:${[...sessionIds][0]}`);
        return h.history.clearBySessionIds(sessionIds);
      },
    },
    candidateRepo: h.candidates,
    liveness: {
      protectedTrackSessionIds: [],
      protectedBackendSessionIds: [],
      activeClaudeCapturePaths: [],
      activeClaudeCapturePairs: [],
    },
    paths: {
      historyDir: h.historyDir,
      piSessionsDir: h.piDir,
      claudeCaptureDir: h.captureDir,
      claudeProjectDir: h.claudeProjectDir,
    },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
  });

  assert.equal(first.registryCommitted, 0);
  const pending = await h.registry.listPendingDeletions();
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].cleanup.claudeBackupPaths, [backupPath]);
  assert.equal(await h.ledger.getConversation('web:track-old'), null, 'ledger may be cleared before a later cleanup step fails');
  await assert.doesNotReject(() => fs.stat(backupPath));

  failHistory = false;
  const second = await runSessionRetentionSweep({
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry,
    ledgerRepo: h.ledger,
    historyRepo: h.history,
    candidateRepo: h.candidates,
    liveness: {
      protectedTrackSessionIds: [],
      protectedBackendSessionIds: [],
      activeClaudeCapturePaths: [],
      activeClaudeCapturePairs: [],
    },
    paths: {
      historyDir: h.historyDir,
      piSessionsDir: h.piDir,
      claudeCaptureDir: h.captureDir,
      claudeProjectDir: h.claudeProjectDir,
    },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
  });

  assert.equal(second.registryCommitted, 1);
  assert.equal(await h.registry.getById('track-old'), null);
  assert.equal(await h.registry.getBoundSessionId('web:track-old'), null);
  assert.equal(await h.history.getHistory('track-old'), null);
  await assert.rejects(() => fs.stat(backupPath), { code: 'ENOENT' });
});

test('retention sweep ignores untrusted Claude ledger backup paths outside the configured project directory', async () => {
  const h = await makeHarness();
  await h.registry.registerSession('cortex-untrusted', registerOpts('track-untrusted', { backendSessionId: 'backend-untrusted' }));
  await h.registry.updateSession('cortex-untrusted', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await h.ledger.initConversation('web:track-untrusted', {
    sessionId: 'track-untrusted', sessionName: 'cortex-untrusted', backend: 'claude',
  });
  await h.ledger.beginTurn('web:track-untrusted', { userMessageTs: 'M1', userMessageText: 'old' });
  const outside = path.join(h.root, 'outside.jsonl.turn-0.bak');
  const symlink = path.join(h.claudeProjectDir, 'backend-untrusted.jsonl.turn-1.bak');
  await fs.writeFile(outside, 'must-survive\n');
  await fs.symlink(outside, symlink);
  await h.ledger.setBackupPath('web:track-untrusted', 'M1', outside);
  await h.ledger.beginTurn('web:track-untrusted', { userMessageTs: 'M2', userMessageText: 'old-2' });
  await h.ledger.setBackupPath('web:track-untrusted', 'M2', symlink);

  const result = await runSessionRetentionSweep({
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry, ledgerRepo: h.ledger, historyRepo: h.history,
    candidateRepo: h.candidates,
    liveness: { protectedTrackSessionIds: [], protectedBackendSessionIds: [], activeClaudeCapturePaths: [], activeClaudeCapturePairs: [] },
    paths: { historyDir: h.historyDir, piSessionsDir: h.piDir, claudeCaptureDir: h.captureDir, claudeProjectDir: h.claudeProjectDir },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
  });

  assert.equal(result.registryCommitted, 1);
  await assert.doesNotReject(() => fs.stat(outside));
  await assert.doesNotReject(() => fs.lstat(symlink));
});

test('retention sweep drops a deleted session\'s carried totals, and leaves surviving ones alone', async () => {
  // The carry is keyed by session id and is written only by the archive sweep, so nothing else
  // would ever remove an entry — without this it outlives every session it describes.
  const h = await makeHarness();
  await h.registry.registerSession('cortex-gone', registerOpts('track-gone'));
  await h.registry.updateSession('cortex-gone', { lastUsedAt: '2020-01-01T00:00:00.000Z' });

  const totals = new SessionTotalsCarryRepo(path.join(h.root, 'session-totals.json'));
  await totals.fold([
    { session: { sessionId: 'track-gone' }, thread: null, runtime: { startedAt: '', updatedAt: '', endedAt: '2020-01-01T00:00:00.000Z' }, metrics: { numTurns: 4, costUsd: 1, durationS: 10 } },
    { session: { sessionId: 'track-kept' }, thread: null, runtime: { startedAt: '', updatedAt: '', endedAt: '2020-01-01T00:00:00.000Z' }, metrics: { numTurns: 9, costUsd: 3, durationS: 30 } },
  ], '2020-02-01T00:00:00.000Z');

  const result = await runSessionRetentionSweep({
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry, ledgerRepo: h.ledger, historyRepo: h.history,
    candidateRepo: h.candidates,
    sessionTotals: totals,
    liveness: { protectedTrackSessionIds: [], protectedBackendSessionIds: [], activeClaudeCapturePaths: [], activeClaudeCapturePairs: [] },
    paths: { historyDir: h.historyDir, piSessionsDir: h.piDir, claudeCaptureDir: h.captureDir, claudeProjectDir: h.claudeProjectDir },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
  });

  assert.equal(result.registryCommitted, 1);
  const carried = await totals.read();
  assert.equal(carried.sessions['track-gone'], undefined, 'the deleted session leaves no carry behind');
  assert.equal(carried.sessions['track-kept']?.turns, 9, 'other sessions are untouched');
  assert.equal(carried.carriedThrough, '2020-02-01T00:00:00.000Z', 'the watermark is not disturbed');
});

test('retention sweep preserves invalid registry dates, syncs Claude helper, and protects active capture pairs', async () => {
  const h = await makeHarness();
  await h.registry.registerSession('cortex-invalid', registerOpts('track-invalid'));
  await h.registry.updateSession('cortex-invalid', { lastUsedAt: 'not-a-date' });
  const activeStem = '2026-08-01T00-00-00Z';
  const activeJsonl = path.join(h.captureDir, `claude-output-${activeStem}.jsonl`);
  const activeTxt = path.join(h.captureDir, `claude-output-${activeStem}.txt`);
  const staleStem = '2026-01-01T00-00-00Z';
  const staleJsonl = path.join(h.captureDir, `claude-output-${staleStem}.jsonl`);
  const staleTxt = path.join(h.captureDir, `claude-output-${staleStem}.txt`);
  await Promise.all([
    fs.writeFile(activeJsonl, 'active-jsonl\n'),
    fs.writeFile(activeTxt, 'active-txt\n'),
    fs.writeFile(staleJsonl, 'stale-jsonl\n'),
    fs.writeFile(staleTxt, 'stale-txt\n'),
  ]);
  const staleTime = new Date('2025-01-01T00:00:00.000Z');
  await Promise.all([
    fs.utimes(staleJsonl, staleTime, staleTime),
    fs.utimes(staleTxt, staleTime, staleTime),
  ]);

  const helperCalls: number[] = [];
  const result = await runSessionRetentionSweep({
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry,
    ledgerRepo: h.ledger,
    historyRepo: h.history,
    candidateRepo: h.candidates,
    liveness: {
      protectedTrackSessionIds: [],
      protectedBackendSessionIds: [],
      activeClaudeCapturePaths: [activeJsonl],
      activeClaudeCapturePairs: [activeStem],
    },
    paths: {
      historyDir: h.historyDir,
      piSessionsDir: h.piDir,
      claudeCaptureDir: h.captureDir,
      claudeProjectDir: h.claudeProjectDir,
    },
    syncClaudeUserCleanupPeriodDays: async (days: number) => {
      helperCalls.push(days);
      return { filePath: '/tmp/settings.json', changed: false };
    },
  });

  assert.deepEqual(helperCalls, [30]);
  assert.ok(await h.registry.getById('track-invalid'));
  assert.equal(result.claudeCaptureDeleted, 2);
  await assert.doesNotReject(() => fs.stat(activeJsonl));
  await assert.rejects(() => fs.stat(staleJsonl));
});

test('retention sweep deletes orphan history and PI transcript bundles only after two consecutive sweeps', async () => {
  const h = await makeHarness();
  const historyPath = path.join(h.historyDir, 'orphan-track.jsonl');
  const piPrimary = path.join(h.piDir, 'backend-orphan.jsonl');
  const piBackup = `${piPrimary}.turn-2.bak`;
  await Promise.all([
    fs.writeFile(historyPath, '{"type":"user","text":"hello","ts":"2026-01-01T00:00:00.000Z"}\n'),
    fs.writeFile(piPrimary, '{}\n'),
    fs.writeFile(piBackup, 'backup\n'),
  ]);
  const oldTime = new Date('2025-01-01T00:00:00.000Z');
  await Promise.all([
    fs.utimes(historyPath, oldTime, oldTime),
    fs.utimes(piPrimary, oldTime, oldTime),
    fs.utimes(piBackup, oldTime, oldTime),
  ]);

  const deps = {
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry,
    ledgerRepo: h.ledger,
    historyRepo: h.history,
    candidateRepo: h.candidates,
    liveness: {
      protectedTrackSessionIds: [],
      protectedBackendSessionIds: [],
      activeClaudeCapturePaths: [],
      activeClaudeCapturePairs: [],
    },
    paths: {
      historyDir: h.historyDir,
      piSessionsDir: h.piDir,
      claudeCaptureDir: h.captureDir,
      claudeProjectDir: h.claudeProjectDir,
    },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
  };

  const first = await runSessionRetentionSweep(deps);
  assert.equal(first.historyOrphanDeleted, 0);
  assert.equal(first.piOrphanDeleted, 0);
  await assert.doesNotReject(() => fs.stat(historyPath));
  await assert.doesNotReject(() => fs.stat(piPrimary));

  const second = await runSessionRetentionSweep(deps);
  assert.equal(second.historyOrphanDeleted, 1);
  assert.equal(second.piOrphanDeleted, 2);
  await assert.rejects(() => fs.stat(historyPath));
  await assert.rejects(() => fs.stat(piPrimary));
  await assert.rejects(() => fs.stat(piBackup));
});

test('retention sweep removes tool-image directories of sessions that are gone, and only those', async () => {
  const h = await makeHarness();
  const toolImagesDir = path.join(h.root, 'tool-images');
  await h.registry.registerSession('cortex-live', registerOpts('track-live'));
  const dirs = ['track-live', 'track-gone', 'track-fresh'].map((name) => path.join(toolImagesDir, name));
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'toolu-1-0.png'), 'png');
  }
  const oldTime = new Date('2025-01-01T00:00:00.000Z');
  await fs.utimes(dirs[0], oldTime, oldTime);
  await fs.utimes(dirs[1], oldTime, oldTime);

  const result = await runSessionRetentionSweep({
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry,
    ledgerRepo: h.ledger,
    historyRepo: h.history,
    candidateRepo: h.candidates,
    liveness: {
      protectedTrackSessionIds: [], protectedBackendSessionIds: [],
      activeClaudeCapturePaths: [], activeClaudeCapturePairs: [],
    },
    paths: {
      historyDir: h.historyDir, piSessionsDir: h.piDir, claudeCaptureDir: h.captureDir,
      claudeProjectDir: h.claudeProjectDir, toolImagesDir,
    },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
  });

  assert.equal(result.toolImagesDeleted, 1);
  await assert.doesNotReject(() => fs.stat(dirs[0]), 'a live session keeps its images');
  await assert.rejects(() => fs.stat(dirs[1]), 'an unregistered, old directory goes');
  await assert.doesNotReject(() => fs.stat(dirs[2]), 'a directory written inside the window stays');
});

test('retention sweep isolates Claude helper and registry failures from capture cleanup', async () => {
  const h = await makeHarness();
  const staleStem = '2026-01-01T00-00-00Z';
  const staleJsonl = path.join(h.captureDir, `claude-output-${staleStem}.jsonl`);
  const staleTxt = path.join(h.captureDir, `claude-output-${staleStem}.txt`);
  await Promise.all([
    fs.writeFile(staleJsonl, 'stale-jsonl\n'),
    fs.writeFile(staleTxt, 'stale-txt\n'),
  ]);
  const oldTime = new Date('2025-01-01T00:00:00.000Z');
  await Promise.all([
    fs.utimes(staleJsonl, oldTime, oldTime),
    fs.utimes(staleTxt, oldTime, oldTime),
  ]);

  const helperFailed = await runSessionRetentionSweep({
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry,
    ledgerRepo: h.ledger,
    historyRepo: h.history,
    candidateRepo: h.candidates,
    liveness: {
      protectedTrackSessionIds: [],
      protectedBackendSessionIds: [],
      activeClaudeCapturePaths: [],
      activeClaudeCapturePairs: [],
    },
    paths: {
      historyDir: h.historyDir,
      piSessionsDir: h.piDir,
      claudeCaptureDir: h.captureDir,
      claudeProjectDir: h.claudeProjectDir,
    },
    syncClaudeUserCleanupPeriodDays: async () => { throw new Error('sync boom'); },
  });
  assert.equal(helperFailed.helperChanged, false);
  assert.equal(helperFailed.claudeCaptureDeleted, 2);
  assert.ok(helperFailed.errors.some((entry) => entry.includes('claude-helper')));

  await Promise.all([
    fs.writeFile(staleJsonl, 'stale-jsonl\n'),
    fs.writeFile(staleTxt, 'stale-txt\n'),
  ]);
  await Promise.all([
    fs.utimes(staleJsonl, oldTime, oldTime),
    fs.utimes(staleTxt, oldTime, oldTime),
  ]);

  const registryFailed = await runSessionRetentionSweep({
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: {
      ...h.registry,
      listRecentSessions: async () => { throw new Error('registry read boom'); },
    } as any,
    ledgerRepo: h.ledger,
    historyRepo: h.history,
    candidateRepo: h.candidates,
    liveness: {
      protectedTrackSessionIds: [],
      protectedBackendSessionIds: [],
      activeClaudeCapturePaths: [],
      activeClaudeCapturePairs: [],
    },
    paths: {
      historyDir: h.historyDir,
      piSessionsDir: h.piDir,
      claudeCaptureDir: h.captureDir,
      claudeProjectDir: h.claudeProjectDir,
    },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
  });
  assert.equal(registryFailed.claudeCaptureDeleted, 2);
  assert.ok(registryFailed.errors.some((entry) => entry.includes('registry.listRecentSessions')));
});

for (const failingMethod of ['listRecentSessions', 'listPendingDeletions'] as const) {
  test(`retention sweep skips history and PI orphan cleanup when registry.${failingMethod} fails`, async () => {
    const h = await makeHarness();
    const historyPath = path.join(h.historyDir, 'orphan-track.jsonl');
    const piPrimary = path.join(h.piDir, 'backend-orphan.jsonl');
    const piBackup = `${piPrimary}.turn-2.bak`;
    const staleStem = '2026-01-01T00-00-00Z';
    const staleJsonl = path.join(h.captureDir, `claude-output-${staleStem}.jsonl`);
    const staleTxt = path.join(h.captureDir, `claude-output-${staleStem}.txt`);
    await Promise.all([
      fs.writeFile(historyPath, 'history\n'),
      fs.writeFile(piPrimary, '{}\n'),
      fs.writeFile(piBackup, 'backup\n'),
      fs.writeFile(staleJsonl, 'capture\n'),
      fs.writeFile(staleTxt, 'capture\n'),
    ]);
    const oldTime = new Date('2025-01-01T00:00:00.000Z');
    await Promise.all([
      fs.utimes(historyPath, oldTime, oldTime),
      fs.utimes(piPrimary, oldTime, oldTime),
      fs.utimes(piBackup, oldTime, oldTime),
      fs.utimes(staleJsonl, oldTime, oldTime),
      fs.utimes(staleTxt, oldTime, oldTime),
    ]);

    const registry = {
      ...h.registry,
      [failingMethod]: async () => { throw new Error(`${failingMethod} boom`); },
    } as any;

    const deps = {
      retentionDays: 30,
      now: () => Date.parse('2026-08-01T00:00:00.000Z'),
      registry,
      ledgerRepo: h.ledger,
      historyRepo: h.history,
      candidateRepo: h.candidates,
      liveness: {
        protectedTrackSessionIds: [],
        protectedBackendSessionIds: [],
        activeClaudeCapturePaths: [],
        activeClaudeCapturePairs: [],
      },
      paths: {
        historyDir: h.historyDir,
        piSessionsDir: h.piDir,
        claudeCaptureDir: h.captureDir,
      claudeProjectDir: h.claudeProjectDir,
      },
      syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
    };

    const first = await runSessionRetentionSweep(deps);
    const second = await runSessionRetentionSweep(deps);

    assert.equal(first.claudeCaptureDeleted, 2);
    assert.equal(second.claudeCaptureDeleted, 0);
    await assert.doesNotReject(() => fs.stat(historyPath));
    await assert.doesNotReject(() => fs.stat(piPrimary));
    await assert.doesNotReject(() => fs.stat(piBackup));
    assert.ok(second.errors.some((entry) => entry.includes(`registry.${failingMethod}`)));
  });
}

test('retention sweep rejects symlink cleanup and parses canonical plus timestamp-prefixed PI filenames exactly', async () => {
  const h = await makeHarness();
  const regularHistory = path.join(h.historyDir, 'orphan-safe.jsonl');
  const historyTarget = path.join(h.root, 'outside-history.jsonl');
  const historyLink = path.join(h.historyDir, 'orphan-link.jsonl');
  const piCanonical = path.join(h.piDir, 'backend-safe.jsonl');
  const piCanonicalBak = `${piCanonical}.turn-2.bak`;
  const piPrefixed = path.join(h.piDir, '2026-08-01T01-02-03Z_backend-prefixed.jsonl');
  const piPrefixedBak = `${piPrefixed}.turn-7.bak`;
  const piNearMiss = path.join(h.piDir, 'backup_2026-08-01T01-02-03Z_backend-prefixed.jsonl');
  const captureTarget = path.join(h.root, 'outside-capture.txt');
  const captureLink = path.join(h.captureDir, 'claude-output-2026-01-01T00-00-00Z.txt');
  await Promise.all([
    fs.writeFile(regularHistory, 'safe\n'),
    fs.writeFile(historyTarget, 'outside\n'),
    fs.symlink(historyTarget, historyLink),
    fs.writeFile(piCanonical, '{}\n'),
    fs.writeFile(piCanonicalBak, 'backup\n'),
    fs.writeFile(piPrefixed, '{}\n'),
    fs.writeFile(piPrefixedBak, 'backup\n'),
    fs.writeFile(piNearMiss, '{}\n'),
    fs.writeFile(captureTarget, 'capture\n'),
    fs.symlink(captureTarget, captureLink),
  ]);
  const oldTime = new Date('2025-01-01T00:00:00.000Z');
  await Promise.all([
    fs.utimes(regularHistory, oldTime, oldTime),
    fs.utimes(piCanonical, oldTime, oldTime),
    fs.utimes(piCanonicalBak, oldTime, oldTime),
    fs.utimes(piPrefixed, oldTime, oldTime),
    fs.utimes(piPrefixedBak, oldTime, oldTime),
    fs.utimes(piNearMiss, oldTime, oldTime),
  ]);

  const deps = {
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry,
    ledgerRepo: h.ledger,
    historyRepo: h.history,
    candidateRepo: h.candidates,
    liveness: {
      protectedTrackSessionIds: [],
      protectedBackendSessionIds: [],
      activeClaudeCapturePaths: [],
      activeClaudeCapturePairs: [],
    },
    paths: {
      historyDir: h.historyDir,
      piSessionsDir: h.piDir,
      claudeCaptureDir: h.captureDir,
      claudeProjectDir: h.claudeProjectDir,
    },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
  };

  await runSessionRetentionSweep(deps);
  const result = await runSessionRetentionSweep(deps);
  assert.equal(result.historyOrphanDeleted, 1);
  assert.equal(result.piOrphanDeleted, 4);
  assert.equal(result.claudeCaptureDeleted, 0);
  assert.ok(result.errors.some((entry) => entry.includes('capture') && entry.includes('symlink')));
  await assert.rejects(() => fs.stat(regularHistory));
  await assert.doesNotReject(() => fs.lstat(historyLink));
  await assert.rejects(() => fs.stat(piCanonical));
  await assert.rejects(() => fs.stat(piCanonicalBak));
  await assert.rejects(() => fs.stat(piPrefixed));
  await assert.rejects(() => fs.stat(piPrefixedBak));
  await assert.doesNotReject(() => fs.stat(piNearMiss));
  await assert.doesNotReject(() => fs.lstat(captureLink));
});

test('retention liveness protects running, bg-held, and pending-interaction sessions', () => {
  const snapshot = buildSessionRetentionLiveness({
    runningExecutions: {
      getAll: () => [
        { trackSessionId: 'track-run', backendSessionId: 'backend-run', sessionId: 'track-run' },
        { trackSessionId: null, backendSessionId: 'backend-legacy', sessionId: 'backend-legacy' },
      ],
    } as any,
    bgHeldSessions: { listIds: () => ['track-bg'] },
    interactionRecords: { pendingSessionIds: () => ['track-pending'] },
    pendingDirectResumeSessionIds: ['track-resume'],
    activeClaudeCapturePaths: ['/tmp/cap-a.jsonl'],
    activeClaudeCapturePairs: ['pair-a'],
  });

  assert.deepEqual(new Set(snapshot.protectedTrackSessionIds), new Set([
    'track-run', 'track-bg', 'track-pending', 'track-resume',
  ]));
  assert.deepEqual(new Set(snapshot.protectedBackendSessionIds), new Set([
    'backend-run', 'backend-legacy',
  ]));
  assert.deepEqual(snapshot.activeClaudeCapturePaths, ['/tmp/cap-a.jsonl']);
  assert.deepEqual(snapshot.activeClaudeCapturePairs, ['pair-a']);
});

test('retention liveness protects exactly the ids a live execution carries', () => {
  const snapshot = buildSessionRetentionLiveness({
    runningExecutions: {
      getAll: () => [
        // An execution with no session id at all protects nothing — there is no third field to
        // fall back on, and `register()` never produced one (it derived its ids from these two).
        {},
        { backendSessionId: 'backend-real' },
      ],
    } as any,
  });

  assert.deepEqual(snapshot.protectedTrackSessionIds, []);
  assert.deepEqual(new Set(snapshot.protectedBackendSessionIds), new Set(['backend-real']));
});

type Harness = Awaited<ReturnType<typeof makeHarness>>;

const OLD = '2020-01-01T00:00:00.000Z';

/** Write `count` expired sessions straight into the journal (one bind, one conversation, one turn
 *  each), with a history file per session; every third session is PI with a transcript bundle, the
 *  rest Claude with one trusted turn backup. */
async function seedExpiredSessions(h: Harness, count: number, extra: (i: number) => Record<string, unknown> = () => ({})) {
  const lines: string[] = [];
  const ids: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `track-${i}`;
    const backendId = `backend-${i}`;
    const channel = `web:${id}`;
    const backend = i % 3 === 0 ? 'pi' : 'claude';
    ids.push(id);
    const backupPath = backend === 'claude' ? path.join(h.claudeProjectDir, `${backendId}.jsonl.turn-0.bak`) : null;
    lines.push(JSON.stringify({ v: 1, op: 'put', id, record: {
      name: `cortex-${id}`, sessionId: id, projectId: 'proj', channel, backend, kind: 'local', origin: 'direct',
      createdAt: OLD, lastUsedAt: OLD, label: null, profileName: null, backendSessionId: backendId, scheduleId: null,
      ...extra(i),
    } }));
    lines.push(JSON.stringify({ v: 1, op: 'bind', channel, sessionId: id }));
    lines.push(JSON.stringify({ v: 1, op: 'conversation', channel, kind: 'set', fields: {
      sessionId: id, sessionName: `cortex-${id}`, backend, profileName: null, updatedAt: OLD,
    } }));
    lines.push(JSON.stringify({ v: 1, op: 'turn', channel, kind: 'begin', turn: {
      turnIndex: 0, userMessageTs: 'M0', userMessageText: 'old', statusMessageTs: null, responseMessageTimestamps: [],
      executionId: null, backupPath, status: 'completed', createdAt: OLD, updatedAt: OLD,
    } }));
    const owned = [path.join(h.historyDir, `${id}.jsonl`)];
    if (backupPath) owned.push(backupPath);
    if (backend === 'pi') owned.push(path.join(h.piDir, `${backendId}.jsonl`), path.join(h.piDir, `${backendId}.jsonl.turn-1.bak`));
    files.push(...owned);
  }
  await fs.writeFile(path.join(h.storeDir, 'session-registry.jsonl'), `${lines.join('\n')}\n`);
  await Promise.all(files.map(filePath => fs.writeFile(filePath, '{}\n')));
  return { ids };
}

function sweepDeps(h: Harness, overrides: Partial<Parameters<typeof runSessionRetentionSweep>[0]> = {}) {
  return {
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry,
    ledgerRepo: h.ledger,
    historyRepo: h.history,
    candidateRepo: h.candidates,
    sessionTotals: new SessionTotalsCarryRepo(path.join(h.root, 'session-totals.json')),
    liveness: { protectedTrackSessionIds: [], protectedBackendSessionIds: [], activeClaudeCapturePaths: [], activeClaudeCapturePairs: [] },
    paths: { historyDir: h.historyDir, piSessionsDir: h.piDir, claudeCaptureDir: h.captureDir, claudeProjectDir: h.claudeProjectDir },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
    ...overrides,
  };
}

async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true, () => false);
}

test('retention sweep commits a large expiry in a bounded number of registry appends', async () => {
  let appends = 0;
  const h = await makeHarness({
    writeAppend: async (handle, text) => { appends += 1; await handle.writeFile(text, 'utf8'); },
  });
  const { ids } = await seedExpiredSessions(h, 250);

  const result = await runSessionRetentionSweep(sweepDeps(h));

  assert.equal(result.registryCommitted, 250);
  assert.deepEqual(result.errors, []);
  // One intent append, then per batch of 100: unbind, conversation clear, commit.
  assert.ok(appends <= 1 + 3 * 3, `registry appends: ${appends}`);
  assert.deepEqual(await h.registry.listRecentSessions(1000), []);
  assert.deepEqual(await h.registry.listPendingDeletions(), []);
  assert.deepEqual(await fs.readdir(h.historyDir), []);
  assert.deepEqual(await fs.readdir(h.piDir), []);
  assert.deepEqual(await fs.readdir(h.claudeProjectDir), []);
  assert.equal(await h.registry.getBoundSessionId(`web:${ids[0]}`), null);
});

test('retention sweep stops between batches and the next sweep retries what was left pending', async () => {
  const h = await makeHarness();
  const { ids } = await seedExpiredSessions(h, 250);
  const abort = new AbortController();
  const commitDeletions = h.registry.commitDeletions.bind(h.registry);
  h.registry.commitDeletions = async (sessionIds) => {
    const committed = await commitDeletions(sessionIds);
    abort.abort();
    return committed;
  };

  const first = await runSessionRetentionSweep(sweepDeps(h, { signal: abort.signal }));

  assert.equal(first.stopped, true);
  assert.equal(first.registryCommitted, 100);
  const pending = await h.registry.listPendingDeletions();
  assert.equal(pending.length, 150);
  assert.equal((await fs.readdir(h.historyDir)).length, 150, 'the unstarted batches keep their files');

  // A restart reads the same journal; the next sweep finishes the leftovers through the retry path.
  const restarted = { ...h, registry: new SessionRegistryRepo(path.join(h.storeDir, 'session-registry.jsonl')) };
  restarted.ledger = new ConversationLedgerRepo(restarted.registry);
  assert.equal((await restarted.registry.listPendingDeletions()).length, 150);
  const second = await runSessionRetentionSweep(sweepDeps(restarted));

  assert.equal(second.stopped, false);
  assert.equal(second.registryCommitted, 150);
  assert.deepEqual(await restarted.registry.listPendingDeletions(), []);
  assert.deepEqual(await restarted.registry.listRecentSessions(1000), []);
  assert.deepEqual(await fs.readdir(h.historyDir), []);
  assert.deepEqual(await fs.readdir(h.piDir), []);
  assert.equal(await restarted.registry.getBoundSessionId(`web:${ids[249]}`), null);
});

test('retention sweep recovers a batch whose cleanup ran but whose commit never landed', async () => {
  const h = await makeHarness();
  await seedExpiredSessions(h, 30);
  h.registry.commitDeletions = async () => { throw new Error('crash before commit'); };

  const first = await runSessionRetentionSweep(sweepDeps(h));

  assert.equal(first.registryCommitted, 0);
  assert.ok(first.errors.some(entry => entry.includes('crash before commit')));
  assert.deepEqual(await fs.readdir(h.historyDir), [], 'cleanup already ran');
  const restarted = { ...h, registry: new SessionRegistryRepo(path.join(h.storeDir, 'session-registry.jsonl')) };
  restarted.ledger = new ConversationLedgerRepo(restarted.registry);
  assert.equal((await restarted.registry.listPendingDeletions()).length, 30, 'intents survive the restart');

  const second = await runSessionRetentionSweep(sweepDeps(restarted));

  assert.equal(second.registryCommitted, 30);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(await restarted.registry.listPendingDeletions(), []);
});

test('retention sweep keeps liveness-protected, leased and dependent sessions across batches', async () => {
  const h = await makeHarness();
  // track-1 leads track-2 (a worker); track-150 is held by a live execution; track-200 has a lease.
  await seedExpiredSessions(h, 250, i => (i === 2 ? { teamLeadId: 'track-1', workerName: 'w' } : {}));
  await sessionStore.registerSession('cortex-leased', {
    sessionId: 'track-200', channel: 'web:track-200', backend: 'claude', kind: 'local', projectId: 'proj',
  });
  const release = await acquireSessionUse('track-200');
  assert.ok(release);

  try {
    const result = await runSessionRetentionSweep(sweepDeps(h, {
      liveness: {
        protectedTrackSessionIds: ['track-1', 'track-150'],
        protectedBackendSessionIds: [],
        activeClaudeCapturePaths: [],
        activeClaudeCapturePairs: [],
      },
    }));

    assert.equal(result.registryCommitted, 246);
    const survivors = (await h.registry.listRecentSessions(1000)).map(session => session.sessionId).sort();
    assert.deepEqual(survivors, ['track-1', 'track-150', 'track-2', 'track-200']);
    for (const id of survivors) {
      assert.ok(await exists(path.join(h.historyDir, `${id}.jsonl`)), `${id} keeps its history`);
      assert.equal(await h.registry.getBoundSessionId(`web:${id}`), id, `${id} keeps its binding`);
    }
  } finally {
    release();
  }
});
