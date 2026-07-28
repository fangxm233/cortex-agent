import '../_test-home.js'; // MUST be first — repoints CORTEX_HOME before paths bind
// input:  session-compact coordinator with injectable state/control deps
// output: idle guards, native control, snapshot, and event assertions
// pos:    Manual session context compaction orchestration tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  compactSessionContext,
  type CompactSessionDeps,
} from '../../src/orchestration/session-compact.js';

const BASE_SESSION = {
  name: 'cortex-a1b2c3',
  sessionId: 'track-1',
  backendSessionId: 'backend-1',
  projectId: 'nimbus',
  channel: 'web:track-1',
  backend: 'pi',
  profileName: 'deepseek',
  contextUsage: {
    usedTokens: 120000,
    contextWindow: 200000,
    percent: 60,
    accuracy: 'estimate' as const,
    updatedAt: '2026-07-28T00:00:00.000Z',
  },
};

interface Log {
  compact: unknown[];
  snapshots: unknown[];
  events: unknown[];
}

function makeDeps(log: Log, overrides: Partial<CompactSessionDeps> = {}): CompactSessionDeps {
  return {
    sessions: {
      getById: async () => ({ ...BASE_SESSION } as any),
      updateContextUsage: async (sessionId, usage) => { log.snapshots.push({ sessionId, usage }); },
    },
    running: { hasChannel: () => false },
    background: { has: () => false },
    queue: {
      has: () => false,
      run: async (_channel, fn) => fn(),
    },
    supports: () => true,
    compactAgent: async (request) => {
      log.compact.push(request);
      return {
        status: 'compacted', tokensBefore: 120000, estimatedTokensAfter: 18000,
        contextUsage: { usedTokens: 19000, contextWindow: 200000, percent: 9.5, accuracy: 'estimate' },
        usage: null,
      };
    },
    publish: (event) => { log.events.push(event); },
    now: () => '2026-07-28T01:00:00.000Z',
    ...overrides,
  };
}

function freshLog(): Log {
  return { compact: [], snapshots: [], events: [] };
}

test('missing stable session returns not-found without touching the backend', async () => {
  const log = freshLog();
  const deps = makeDeps(log, {
    sessions: {
      ...makeDeps(log).sessions,
      getById: async () => null,
    },
  });
  assert.deepEqual(await compactSessionContext('missing', deps), { ok: false, reason: 'not-found' });
  assert.equal(log.compact.length, 0);
});

test('no backend history is a harmless not-needed outcome and spawns no control process', async () => {
  const log = freshLog();
  const deps = makeDeps(log, {
    sessions: {
      ...makeDeps(log).sessions,
      getById: async () => ({ ...BASE_SESSION, backendSessionId: null } as any),
    },
  });
  const result = await compactSessionContext('track-1', deps);
  assert.deepEqual(result, { ok: true, status: 'not-needed', contextUsage: BASE_SESSION.contextUsage });
  assert.equal(log.compact.length, 0);
});

test('unsupported and every busy source reject before compaction', async () => {
  for (const overrides of [
    { supports: () => false },
    { running: { hasChannel: () => true } },
    { background: { has: () => true } },
    { queue: { has: () => true, run: async (_channel: string, fn: () => Promise<any>) => fn() } },
  ]) {
    const log = freshLog();
    const result = await compactSessionContext('track-1', makeDeps(log, overrides as any));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, overrides.supports ? 'unsupported' : 'running');
    assert.equal(log.compact.length, 0);
  }
});

test('a second compact sees the first queue reservation and returns running', async () => {
  const log = freshLog();
  let queued = false;
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const deps = makeDeps(log, {
    queue: {
      has: () => queued,
      run: async (_channel, fn) => {
        queued = true;
        try { return await fn(); } finally { queued = false; }
      },
    },
    compactAgent: async (request) => {
      log.compact.push(request);
      started();
      await blocked;
      return {
        status: 'compacted', tokensBefore: 120000, estimatedTokensAfter: 18000,
        contextUsage: null, usage: null,
      };
    },
  });

  const first = compactSessionContext('track-1', deps);
  await didStart;
  assert.deepEqual(await compactSessionContext('track-1', deps), { ok: false, reason: 'running' });
  release();
  assert.equal((await first).ok, true);
  assert.equal(log.compact.length, 1);
});

test('successful PI compact persists post stats and publishes semantic session event', async () => {
  const log = freshLog();
  const result = await compactSessionContext('track-1', makeDeps(log));
  const contextUsage = {
    usedTokens: 19000, contextWindow: 200000, percent: 9.5, accuracy: 'estimate' as const,
    updatedAt: '2026-07-28T01:00:00.000Z',
  };
  assert.deepEqual(result, { ok: true, status: 'compacted', contextUsage });
  assert.deepEqual(log.compact, [{
    sessionId: 'track-1', backend: 'pi', backendSessionId: 'backend-1', channel: 'web:track-1',
    profileName: 'deepseek', projectId: 'nimbus', sessionName: 'cortex-a1b2c3',
  }]);
  assert.deepEqual(log.snapshots, [{ sessionId: 'track-1', usage: contextUsage }]);
  assert.deepEqual(log.events, [{
    sessionId: 'track-1', channel: 'web:track-1', status: 'compacted', contextUsage,
  }]);
});

test('successful compact without post stats clears stale context, while not-needed preserves it', async () => {
  const clearedLog = freshLog();
  const cleared = await compactSessionContext('track-1', makeDeps(clearedLog, {
    compactAgent: async () => ({
      status: 'compacted', tokensBefore: 64000, estimatedTokensAfter: null,
      contextUsage: null, usage: null,
    }),
  }));
  assert.deepEqual(cleared, { ok: true, status: 'compacted', contextUsage: null });
  assert.deepEqual(clearedLog.snapshots, [{ sessionId: 'track-1', usage: null }]);

  const noopLog = freshLog();
  const noop = await compactSessionContext('track-1', makeDeps(noopLog, {
    compactAgent: async () => ({
      status: 'not-needed', tokensBefore: null, estimatedTokensAfter: null,
      contextUsage: null, usage: null,
    }),
  }));
  assert.deepEqual(noop, { ok: true, status: 'not-needed', contextUsage: BASE_SESSION.contextUsage });
  assert.deepEqual(noopLog.snapshots, []);
  assert.deepEqual(noopLog.events, []);
});
