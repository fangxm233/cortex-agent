// input:  ../_test-home, vitest, tmp fs, and session registry repo/journal helpers
// output: Legacy migration, coexistence, backup, prune, and replacement failure tests
// pos:    Session registry migration and reference behavior coverage
// >>> If I am updated, update my header comment and the parent folder CORTEX.md <<<

import '../_test-home.js';
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistryRepo, type Session } from '../../src/store/session-registry-repo.js';
import { compactSessionRegistry } from '../../src/store/session-registry-journal.js';
import { STORE_DIR } from '../../src/core/paths.js';
import { executionRepo } from '../../src/store/execution-repo.js';
import { threadStore } from '../../src/store/thread-repo.js';
import type { ThreadRecord } from '../../src/core/types/thread-types.js';

let tmpDir = '';
let testId = 0;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-session-store-jsonl-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function nextPaths() {
  const id = testId++;
  const filePath = path.join(tmpDir, `session-registry-${id}.jsonl`);
  return {
    filePath,
    legacyPath: filePath.replace(/\.jsonl$/, '.json'),
    backupPath: filePath.replace(/\.jsonl$/, '.json.bak'),
  };
}

function oldRecord(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    channel: 'C001',
    backend: 'claude',
    kind: 'local',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastUsedAt: '2025-06-01T00:00:00.000Z',
    label: null,
    profileName: null,
    ...extra,
  };
}

async function readMaybe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function liveSession(id: string, name: string): Session {
  return {
    name,
    sessionId: id,
    projectId: 'proj',
    channel: 'C001',
    backend: 'claude',
    kind: 'local',
    origin: 'direct',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastUsedAt: '2025-01-01T00:00:00.000Z',
    label: null,
    profileName: null,
    backendSessionId: null,
    scheduleId: null,
  };
}

test('session store migrates legacy JSON into temp JSONL and keeps a backup', async () => {
  const { filePath, legacyPath, backupPath } = nextPaths();
  await fs.writeFile(legacyPath, JSON.stringify({
    'cortex-a': oldRecord('sess-a'),
    'cortex-b': oldRecord('sess-b', { kind: 'scheduled' }),
  }, null, 2));

  const repo = new SessionRegistryRepo(filePath);
  const sessions = await repo.listRecentSessions(10);

  assert.deepEqual(new Set(sessions.map(session => session.sessionId)), new Set(['sess-a', 'sess-b']));
  assert.equal((await repo.getById('sess-a'))?.name, 'cortex-a');
  assert.equal((await repo.getById('sess-b'))?.origin, 'scheduled');
  assert.equal(await fs.readFile(backupPath, 'utf8'), await fs.readFile(legacyPath, 'utf8'));
  assert.ok((await fs.readFile(filePath, 'utf8')).includes('"op":"put"'));
});

test('session store migration does not overwrite a conflicting legacy backup path', async () => {
  const { filePath, legacyPath, backupPath } = nextPaths();
  await fs.writeFile(legacyPath, JSON.stringify({ 'cortex-a': oldRecord('sess-a') }, null, 2));
  await fs.writeFile(backupPath, 'keep-existing-backup\n');

  const repo = new SessionRegistryRepo(filePath);
  await repo.listRecentSessions(10);

  assert.equal(await fs.readFile(backupPath, 'utf8'), 'keep-existing-backup\n');
  const backups = (await fs.readdir(path.dirname(filePath)))
    .filter(name => name.startsWith(path.basename(backupPath)));
  assert.ok(backups.length >= 2, `expected conflict-safe backup copy, got ${backups.join(', ')}`);
});

test('session store migration fails closed for malformed legacy shapes and never writes partial jsonl or backup', async () => {
  const badCases: Array<{ label: string; raw: unknown; message: RegExp }> = [
    { label: 'top-level array', raw: [], message: /legacy|object|format/i },
    { label: 'entry not object', raw: { 'cortex-a': 'nope' }, message: /legacy|object/i },
    { label: 'missing sessionId', raw: { 'cortex-a': { channel: 'C001', backend: 'claude', kind: 'local', createdAt: '2025-01-01T00:00:00.000Z', lastUsedAt: '2025-01-01T00:00:00.000Z' } }, message: /string field|sessionid|unrecognizable/i },
    { label: 'new-format key mismatch', raw: { 'sess-a': { ...liveSession('sess-b', 'cortex-a') } }, message: /id mismatch/i },
    { label: 'new-format duplicate names', raw: { 'sess-a': { ...liveSession('sess-a', 'cortex-dup') }, 'sess-b': { ...liveSession('sess-b', 'cortex-dup') } }, message: /duplicate live session name/i },
    { label: 'unrecognizable mixed format', raw: { 'cortex-old': oldRecord('sess-old'), 'sess-new': { ...liveSession('sess-new', 'cortex-new') } }, message: /invalid session registry|string field|format/i },
  ];

  for (const badCase of badCases) {
    const { filePath, legacyPath, backupPath } = nextPaths();
    await fs.writeFile(legacyPath, JSON.stringify(badCase.raw, null, 2));

    const repo = new SessionRegistryRepo(filePath);
    await assert.rejects(repo.listRecentSessions(10), badCase.message, badCase.label);
    assert.equal(await readMaybe(filePath), null, `${badCase.label}: jsonl must not be written`);
    assert.equal(await readMaybe(backupPath), null, `${badCase.label}: backup must not be written`);
  }
});

// Known-legal legacy semantics: multiple names may point at the same sessionId; migration keeps the
// most recent lastUsedAt record.
test('session store migration dedups old-format duplicate session ids by latest lastUsedAt', async () => {
  const { filePath, legacyPath } = nextPaths();
  await fs.writeFile(legacyPath, JSON.stringify({
    'cortex-old': oldRecord('sess-a', { lastUsedAt: '2025-01-01T00:00:00.000Z' }),
    'cortex-new': oldRecord('sess-a', { lastUsedAt: '2025-06-01T00:00:00.000Z' }),
  }, null, 2));

  const repo = new SessionRegistryRepo(filePath);
  const sessions = await repo.listRecentSessions(10);

  assert.deepEqual(sessions.map((session) => session.name), ['cortex-new']);
  assert.equal((await repo.getById('sess-a'))?.lastUsedAt, '2025-06-01T00:00:00.000Z');
});

test('session store old-format migration backfills projectId from reverse channel map without sync fs io', async () => {
  const { filePath, legacyPath } = nextPaths();
  const channelRegistryPath = path.join(STORE_DIR, 'channel-registry.json');
  const priorChannelRegistry = await readMaybe(channelRegistryPath);
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(channelRegistryPath, JSON.stringify({ projMapped: 'C001' }, null, 2));
  await fs.writeFile(legacyPath, JSON.stringify({ 'cortex-a': oldRecord('sess-a') }, null, 2));

  try {
    const repo = new SessionRegistryRepo(filePath);
    const sessions = await repo.listRecentSessions(10);
    assert.equal(sessions[0]?.projectId, 'projMapped');
    assert.equal((await repo.getById('sess-a'))?.projectId, 'projMapped');

    const source = await fs.readFile(new URL('../../src/store/session-registry-journal.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\breadFileSync\b|\breaddirSync\b|\bstatSync\b|\bwriteFileSync\b/);
  } finally {
    if (priorChannelRegistry === null) await fs.rm(channelRegistryPath, { force: true });
    else await fs.writeFile(channelRegistryPath, priorChannelRegistry);
  }
});
test('session store rejects empty JSONL when a non-empty legacy JSON still exists', async () => {
  const { filePath, legacyPath } = nextPaths();
  await fs.writeFile(filePath, '');
  await fs.writeFile(legacyPath, JSON.stringify({ 'cortex-a': oldRecord('sess-a') }, null, 2));

  const repo = new SessionRegistryRepo(filePath);
  await assert.rejects(repo.listRecentSessions(10), /empty jsonl.*legacy/i);
});

test('session store treats existing JSONL as authoritative when JSONL and legacy JSON coexist', async () => {
  const { filePath, legacyPath } = nextPaths();
  await fs.writeFile(filePath, `${JSON.stringify({
    v: 1, op: 'put', id: 'sess-jsonl', record: liveSession('sess-jsonl', 'cortex-jsonl'),
  })}\n`);
  await fs.writeFile(legacyPath, JSON.stringify({ 'cortex-legacy': oldRecord('sess-legacy') }, null, 2));

  const repo = new SessionRegistryRepo(filePath);
  const sessions = await repo.listRecentSessions(10);
  assert.deepEqual(sessions.map(session => session.sessionId), ['sess-jsonl']);
  assert.equal(await repo.getById('sess-legacy'), null);
});

test('session store does not fall back to legacy JSON when JSONL exists but is malformed', async () => {
  const { filePath, legacyPath } = nextPaths();
  await fs.writeFile(filePath, '{bad json}\n');
  await fs.writeFile(legacyPath, JSON.stringify({ 'cortex-legacy': oldRecord('sess-legacy') }, null, 2));

  const repo = new SessionRegistryRepo(filePath);
  await assert.rejects(repo.listRecentSessions(10), /malformed/i);
  await assert.rejects(repo.registerSession('cortex-new', {
    sessionId: 'sess-new', channel: 'C001', backend: 'claude', kind: 'local', projectId: 'proj',
  }), /malformed/i);
  assert.equal(await fs.readFile(filePath, 'utf8'), '{bad json}\n');
});

test('session store pruneStale returns committed deletions and preserves referenced sessions', async () => {
  const { filePath } = nextPaths();
  const repo = new SessionRegistryRepo(filePath);
  await repo.registerSession('cortex-exec-ref', {
    sessionId: 'sess-exec-ref', channel: 'C001', backend: 'claude', kind: 'local', projectId: 'proj',
  });
  await repo.registerSession('cortex-thread-ref', {
    sessionId: 'sess-thread-ref', channel: 'C001', backend: 'claude', kind: 'local', projectId: 'proj',
  });
  await repo.registerSession('cortex-unref', {
    sessionId: 'sess-unref', channel: 'C001', backend: 'claude', kind: 'local', projectId: 'proj',
  });
  await repo.registerSession('cortex-invalid-date', {
    sessionId: 'sess-invalid-date', channel: 'C001', backend: 'claude', kind: 'local', projectId: 'proj',
  });
  await repo.updateSession('cortex-exec-ref', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.updateSession('cortex-thread-ref', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.updateSession('cortex-unref', { lastUsedAt: '2020-01-01T00:00:00.000Z' });
  await repo.updateSession('cortex-invalid-date', { lastUsedAt: 'not-a-date' });

  executionRepo.startLocalExecution({ sessionId: 'sess-exec-ref', channel: 'C001', project: 'proj' });
  const threadRecord: ThreadRecord = {
    id: 'thr_gc_test',
    templateName: null,
    status: 'running',
    channel: 'C001',
    projectId: 'proj',
    platformThreadId: null,
    userMessage: 'test',
    userMessageTs: '1',
    workspacePath: '/tmp/workspace',
    artifactPath: '/tmp/workspace/artifact.md',
    agents: {
      agent1: {
        slotId: 'agent1', profile: 'default', sessionId: 'sess-thread-ref', sessionName: null,
        status: 'completed', lastOutput: null, persistSession: false,
      },
    },
    activeAgent: 'agent1',
    activeStage: null,
    currentStepIndex: 0,
    steps: [],
    iterationCounts: {},
    totalCostUsd: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    endedAt: null,
    error: null,
    abortReason: null,
  };
  await threadStore.set(threadRecord);

  const removed = await repo.pruneStale(86_400_000 * 7);
  assert.equal(removed, 1);
  assert.ok(await repo.getById('sess-exec-ref'));
  assert.ok(await repo.getById('sess-thread-ref'));
  assert.ok(await repo.getById('sess-invalid-date'));
  assert.equal(await repo.getById('sess-unref'), null);
});

test('session store replacement failure cleans temporary files', async () => {
  const targetDir = path.join(tmpDir, `session-registry-dir-${testId++}`);
  await fs.mkdir(targetDir, { recursive: true });

  await assert.rejects(() => compactSessionRegistry(targetDir, {
    live: new Map([['sess-a', liveSession('sess-a', 'cortex-a')]]),
    pending: new Map(),
    nameIndex: new Map([['cortex-a', 'sess-a']]),
    eventCount: 1,
    fileSize: 0,
  }), /directory|dir|eisdir|eperm|access/i);

  const leftovers = (await fs.readdir(path.dirname(targetDir)))
    .filter(name => name.startsWith(`${path.basename(targetDir)}.tmp.`));
  assert.deepEqual(leftovers, []);
});
