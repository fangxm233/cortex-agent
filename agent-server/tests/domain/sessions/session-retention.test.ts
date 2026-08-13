// input:  temp filesystem, retention sweep deps, registry/session stores
// output: session retention sweep regressions across registry, orphans, and helper sync
// pos:    Exercises the orchestration-free retention sweep contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../../_test-home.js';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo, type Session } from '../../../src/store/session-registry-repo.js';
import { SessionRepo } from '../../../src/store/session-repo.js';
import { ConversationLedgerRepo } from '../../../src/store/conversation-ledger-repo.js';
import { ConversationHistoryRepo } from '../../../src/store/conversation-history-repo.js';
import { RetentionCandidateRepo } from '../../../src/store/retention-candidate-repo.js';
import { runSessionRetentionSweep } from '../../../src/domain/sessions/session-retention.js';
import { buildSessionRetentionLiveness } from '../../../src/core/session-retention-liveness.js';

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

async function makeHarness() {
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
  return {
    root,
    storeDir,
    historyDir,
    piDir,
    captureDir,
    claudeProjectDir,
    registry: new SessionRegistryRepo(path.join(storeDir, 'session-registry.jsonl')),
    bindings: new SessionRepo(path.join(storeDir, 'sessions.json')),
    ledger: new ConversationLedgerRepo(path.join(storeDir, 'conversation-ledger.json')),
    history: new ConversationHistoryRepo(historyDir),
    candidates: new RetentionCandidateRepo(path.join(storeDir, 'retention-candidates.json')),
  };
}

test('retention sweep retries pending intents, does not commit failed cleanup, then retries successfully', async () => {
  const h = await makeHarness();
  await h.registry.registerSession('cortex-old', registerOpts('track-old', { backendSessionId: 'backend-old' }));
  await h.registry.updateSession('cortex-old', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await h.bindings.setSessionAsync('web:track-old', 'track-old', 'claude');
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
    sessionRepo: h.bindings,
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
    sessionRepo: h.bindings,
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
  assert.equal(await h.bindings.getSessionAsync('web:track-old', 'claude'), undefined);
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
    registry: h.registry, sessionRepo: h.bindings, ledgerRepo: h.ledger, historyRepo: h.history,
    candidateRepo: h.candidates,
    liveness: { protectedTrackSessionIds: [], protectedBackendSessionIds: [], activeClaudeCapturePaths: [], activeClaudeCapturePairs: [] },
    paths: { historyDir: h.historyDir, piSessionsDir: h.piDir, claudeCaptureDir: h.captureDir, claudeProjectDir: h.claudeProjectDir },
    syncClaudeUserCleanupPeriodDays: async () => ({ filePath: '/tmp/settings.json', changed: false }),
  });

  assert.equal(result.registryCommitted, 1);
  await assert.doesNotReject(() => fs.stat(outside));
  await assert.doesNotReject(() => fs.lstat(symlink));
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
    sessionRepo: h.bindings,
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
    sessionRepo: h.bindings,
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
    sessionRepo: h.bindings,
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
    sessionRepo: h.bindings,
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
  test(`retention sweep skips history, PI orphan, and dangling-reference repair when registry.${failingMethod} fails`, async () => {
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
    await h.bindings.setSessionAsync('web:missing', 'track-missing', 'claude');
    await h.ledger.initConversation('web:missing', {
      sessionId: 'track-missing', sessionName: 'cortex-missing', backend: 'claude',
    });

    const registry = {
      ...h.registry,
      [failingMethod]: async () => { throw new Error(`${failingMethod} boom`); },
    } as any;

    const deps = {
      retentionDays: 30,
      now: () => Date.parse('2026-08-01T00:00:00.000Z'),
      registry,
      sessionRepo: h.bindings,
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
    assert.equal(await h.bindings.getSessionAsync('web:missing', 'claude'), 'track-missing');
    assert.ok(await h.ledger.getConversation('web:missing'));
    assert.ok(second.errors.some((entry) => entry.includes(`registry.${failingMethod}`)));
  });
}

test('retention sweep repairs stale session bindings and ledgers for missing registry ids while preserving live ids', async () => {
  const h = await makeHarness();
  await h.registry.registerSession('cortex-live', registerOpts('track-live'));
  await h.bindings.setSessionAsync('web:live', 'track-live', 'claude');
  await h.bindings.setSessionAsync('web:missing', 'track-missing', 'claude');
  await h.ledger.initConversation('web:live', {
    sessionId: 'track-live', sessionName: 'cortex-live', backend: 'claude',
  });
  await h.ledger.initConversation('web:missing', {
    sessionId: 'track-missing', sessionName: 'cortex-missing', backend: 'claude',
  });

  await runSessionRetentionSweep({
    retentionDays: 30,
    now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    registry: h.registry,
    sessionRepo: h.bindings,
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

  assert.equal(await h.bindings.getSessionAsync('web:live', 'claude'), 'track-live');
  assert.equal(await h.bindings.getSessionAsync('web:missing', 'claude'), undefined);
  assert.ok(await h.ledger.getConversation('web:live'));
  assert.equal(await h.ledger.getConversation('web:missing'), null);
});

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
    sessionRepo: h.bindings,
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

test('retention liveness protects running, waiting, rate-limited, bg-held, and pending-interaction sessions', () => {
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
    threads: [
      {
        status: 'waiting',
        agents: {
          main: {
            slotId: 'main', profile: 'default', sessionId: 'track-agent', backendSessionId: 'backend-agent',
            sessionName: null, status: 'running', lastOutput: null, persistSession: true,
          },
        },
        steps: [
          {
            stepIndex: 0, agentSlotId: 'main', stage: null, executionId: null,
            sessionId: 'track-step', backendSessionId: 'backend-step', sessionName: null,
            input: '', output: null, costUsd: null, numTurns: null, durationS: null, startedAt: null, endedAt: null,
          },
        ],
      },
      {
        status: 'rate_limited',
        agents: {
          aux: {
            slotId: 'aux', profile: 'default', sessionId: 'track-rate', backendSessionId: undefined,
            sessionName: null, status: 'running', lastOutput: null, persistSession: true,
          },
        },
        steps: [],
      },
      {
        status: 'completed',
        agents: {
          done: {
            slotId: 'done', profile: 'default', sessionId: 'track-done', backendSessionId: 'backend-done',
            sessionName: null, status: 'completed', lastOutput: null, persistSession: true,
          },
        },
        steps: [{
          stepIndex: 1, agentSlotId: 'done', stage: null, executionId: null,
          sessionId: 'track-done-step', backendSessionId: 'backend-done-step', sessionName: null,
          input: '', output: null, costUsd: null, numTurns: null, durationS: null, startedAt: null, endedAt: null,
        }],
      },
    ],
    activeClaudeCapturePaths: ['/tmp/cap-a.jsonl'],
    activeClaudeCapturePairs: ['pair-a'],
  });

  assert.deepEqual(new Set(snapshot.protectedTrackSessionIds), new Set([
    'track-run', 'track-bg', 'track-pending', 'track-resume', 'track-agent', 'track-step', 'track-rate',
  ]));
  assert.deepEqual(new Set(snapshot.protectedBackendSessionIds), new Set([
    'backend-run', 'backend-legacy', 'backend-agent', 'backend-step', 'track-rate',
  ]));
  assert.deepEqual(snapshot.activeClaudeCapturePaths, ['/tmp/cap-a.jsonl']);
  assert.deepEqual(snapshot.activeClaudeCapturePairs, ['pair-a']);
});

test('retention liveness only dual-protects legacy execution sessionId when both explicit ids are absent', () => {
  const snapshot = buildSessionRetentionLiveness({
    runningExecutions: {
      getAll: () => [
        { sessionId: 'legacy-both-missing' },
        { sessionId: 'legacy-backend-only', backendSessionId: 'backend-real' },
      ],
    } as any,
  });

  assert.deepEqual(new Set(snapshot.protectedTrackSessionIds), new Set(['legacy-both-missing']));
  assert.deepEqual(new Set(snapshot.protectedBackendSessionIds), new Set(['legacy-both-missing', 'backend-real']));
});
