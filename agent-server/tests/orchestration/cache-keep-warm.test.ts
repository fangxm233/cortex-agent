import { describe, test } from 'vitest';
import assert from 'node:assert/strict';

import {
  hasWakeSource, sweepCacheKeepWarm,
  type KeepWarmCostEntry, type KeepWarmDeps, type KeepWarmTarget, type WakeSourceDeps,
} from '../../src/orchestration/cache-keep-warm.js';
import type { CacheRefreshResult } from '../../src/agent-adapter/claude/cache-refresh.js';
import type { WorkerView } from '../../src/orchestration/team-state.js';
import type { Session } from '../../src/store/session-registry-repo.js';

const MIN = 60_000;
const NOW = Date.parse('2026-10-19T20:00:00.000Z');

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'track-1',
    backendSessionId: 'backend-1',
    projectId: 'nimbus',
    channel: 'web:track-1',
    backend: 'claude',
    selection: { backend: 'claude', provider: null, model: 'claude-x', thinking: null, mode: 'plan' },
    contextUsage: {
      usedTokens: 165_000, contextWindow: 1_000_000, percent: 16.5, accuracy: 'exact',
      updatedAt: '2026-10-19T19:00:00.000Z',
    },
    ...overrides,
  } as Session;
}

const RESULT: CacheRefreshResult = {
  usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 165_180, cacheWriteTokens: 1_017 },
  model: 'claude-x', costUsd: 0.041, durationMs: 6_000,
};

interface Log {
  refreshed: string[];
  queued: string[];
  noted: Array<[string, number]>;
  costs: KeepWarmCostEntry[];
}

interface Clock {
  /** Last model activity, per backend session id; absent = no transcript. */
  active: Record<string, number>;
  /** Last cache touch, per backend session id; defaults to the activity. */
  touched?: Record<string, number>;
}

function makeDeps(sessions: Session[], clock: Clock, overrides: Partial<KeepWarmDeps> = {}) {
  const log: Log = { refreshed: [], queued: [], noted: [], costs: [] };
  const deps: KeepWarmDeps = {
    listSessions: async () => sessions,
    settings: () => ({ hours: 6, subscriptionModes: ['plan'] }),
    selection: (s) => s.selection!,
    transcriptPath: (id) => `/transcripts/${id}.jsonl`,
    lastActivity: (p) => clock.active[idOf(p)] ?? null,
    lastTouch: (p) => clock.touched?.[idOf(p)] ?? clock.active[idOf(p)] ?? null,
    hasWakeSource: async () => true,
    busy: () => false,
    runQueued: async (channel, fn) => { log.queued.push(channel); return fn(); },
    refresh: async (target: KeepWarmTarget) => { log.refreshed.push(target.session.sessionId); return RESULT; },
    noteRefresh: (id, at) => { log.noted.push([id, at]); },
    recordCost: async (entry) => { log.costs.push(entry); },
    now: () => NOW,
    ...overrides,
  };
  return { deps, log };
}

function idOf(transcriptPath: string): string {
  return transcriptPath.replace('/transcripts/', '').replace('.jsonl', '');
}

describe('sweepCacheKeepWarm', () => {
  test('refreshes an idle session nearing the hour, records it and its cost', async () => {
    const { deps, log } = makeDeps([session()], { active: { 'backend-1': NOW - 55 * MIN } });
    assert.equal(await sweepCacheKeepWarm(deps), 1);
    assert.deepEqual(log.refreshed, ['track-1']);
    assert.deepEqual(log.queued, ['web:track-1']);
    assert.deepEqual(log.noted, [['backend-1', NOW]]);
    assert.deepEqual(log.costs, [{
      project: 'nimbus', trigger: 'cache-refresh', cost_usd: 0.041, backend: 'claude', mode: 'plan',
      source: 'estimate', input_tokens: 2, output_tokens: 4, prompt_tokens: 166_199,
      cache_read_tokens: 165_180, cache_creation_tokens: 1_017, provider: 'anthropic', model: 'claude-x',
      session_id: 'track-1',
    }]);
  });

  test('does nothing when the setting is 0', async () => {
    const { deps, log } = makeDeps([session()], { active: { 'backend-1': NOW - 55 * MIN } }, {
      settings: () => ({ hours: 0, subscriptionModes: ['plan'] }),
    });
    assert.equal(await sweepCacheKeepWarm(deps), 0);
    assert.deepEqual(log.refreshed, []);
  });

  test('skips sessions that fail a gate', async () => {
    const due = NOW - 55 * MIN;
    const pi = session({ sessionId: 'pi', backendSessionId: 'pi', backend: 'pi' });
    const small = session({
      sessionId: 'small', backendSessionId: 'small',
      contextUsage: { ...session().contextUsage!, usedTokens: 99_999 },
    });
    const noHistory = session({ sessionId: 'fresh', backendSessionId: null });
    const apiMode = session({
      sessionId: 'api', backendSessionId: 'api',
      selection: { backend: 'claude', provider: null, model: 'claude-x', thinking: null, mode: 'api' },
    });
    const noTranscript = session({ sessionId: 'gone', backendSessionId: 'gone' });
    const { deps, log } = makeDeps([pi, small, noHistory, apiMode, noTranscript], {
      active: { pi: due, small: due, api: due },
    });
    assert.equal(await sweepCacheKeepWarm(deps), 0);
    assert.deepEqual(log.refreshed, []);
  });

  test('skips a session whose next turn cannot resolve a selection', async () => {
    const { deps, log } = makeDeps([session()], { active: { 'backend-1': NOW - 55 * MIN } }, {
      selection: () => { throw new Error('Cannot resume claude session on pi backend'); },
    });
    assert.equal(await sweepCacheKeepWarm(deps), 0);
    assert.deepEqual(log.refreshed, []);
  });

  test('skips a session nothing will wake', async () => {
    const { deps, log } = makeDeps([session()], { active: { 'backend-1': NOW - 55 * MIN } }, {
      hasWakeSource: async () => false,
    });
    assert.equal(await sweepCacheKeepWarm(deps), 0);
    assert.deepEqual(log.refreshed, []);
  });

  test('waits until the cache is 50 minutes old, counting a previous refresh', async () => {
    const active = NOW - 3 * 60 * MIN;
    const young = makeDeps([session()], { active: { 'backend-1': NOW - 49 * MIN } });
    assert.equal(await sweepCacheKeepWarm(young.deps), 0);
    const refreshedRecently = makeDeps([session()], {
      active: { 'backend-1': active }, touched: { 'backend-1': NOW - 30 * MIN },
    });
    assert.equal(await sweepCacheKeepWarm(refreshedRecently.deps), 0);
    const refreshedLongAgo = makeDeps([session()], {
      active: { 'backend-1': active }, touched: { 'backend-1': NOW - 50 * MIN },
    });
    assert.equal(await sweepCacheKeepWarm(refreshedLongAgo.deps), 1);
  });

  test('stops once the last model activity is older than the cap', async () => {
    const touched = { 'backend-1': NOW - 55 * MIN };
    const within = makeDeps([session()], { active: { 'backend-1': NOW - 6 * 60 * MIN }, touched });
    assert.equal(await sweepCacheKeepWarm(within.deps), 1);
    const beyond = makeDeps([session()], { active: { 'backend-1': NOW - 6 * 60 * MIN - 1 }, touched });
    assert.equal(await sweepCacheKeepWarm(beyond.deps), 0);
    const shorterCap = makeDeps([session()], { active: { 'backend-1': NOW - 2 * 60 * MIN }, touched }, {
      settings: () => ({ hours: 1.5, subscriptionModes: ['plan'] }),
    });
    assert.equal(await sweepCacheKeepWarm(shorterCap.deps), 0);
  });

  test('skips a busy channel', async () => {
    const { deps, log } = makeDeps([session()], { active: { 'backend-1': NOW - 55 * MIN } }, {
      busy: (channel) => channel === 'web:track-1',
    });
    assert.equal(await sweepCacheKeepWarm(deps), 0);
    assert.deepEqual(log.queued, []);
  });

  test('skips inside the queue when a turn got there first', async () => {
    const clock: Clock = { active: { 'backend-1': NOW - 55 * MIN } };
    const { deps, log } = makeDeps([session()], clock, {
      runQueued: async (_channel, fn) => { clock.active['backend-1'] = NOW - MIN; return fn(); },
    });
    assert.equal(await sweepCacheKeepWarm(deps), 0);
    assert.deepEqual(log.refreshed, []);
    assert.deepEqual(log.noted, []);
  });

  test('a failed refresh is logged and the sweep moves on, one session at a time', async () => {
    const order: string[] = [];
    let inFlight = 0;
    const sessions = [
      session({ sessionId: 'a', backendSessionId: 'a', channel: 'web:a' }),
      session({ sessionId: 'b', backendSessionId: 'b', channel: 'web:b' }),
    ];
    const { deps, log } = makeDeps(sessions, { active: { a: NOW - 55 * MIN, b: NOW - 55 * MIN } }, {
      refresh: async (target) => {
        inFlight++;
        assert.equal(inFlight, 1);
        order.push(target.session.sessionId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        if (target.session.sessionId === 'a') throw new Error('no result within 90000ms');
        return RESULT;
      },
    });
    assert.equal(await sweepCacheKeepWarm(deps), 1);
    assert.deepEqual(order, ['a', 'b']);
    assert.deepEqual(log.noted.map(([id]) => id), ['b']);
  });
});

describe('hasWakeSource', () => {
  function worker(status: WorkerView['status']): WorkerView {
    return {
      name: 'w', sessionId: 'w1', channel: 'web:w1', status, waitingOn: [], waitpoints: 0,
      brief: null, lastReport: null, userTouched: false, inactive: false,
    };
  }

  function wakeDeps(overrides: Partial<WakeSourceDeps> = {}): WakeSourceDeps {
    return {
      backgroundRuns: () => false,
      openWaitpoints: async () => 0,
      isLead: () => false,
      team: async () => [],
      ...overrides,
    };
  }

  test('nothing pending: no wake', async () => {
    assert.equal(await hasWakeSource(session(), wakeDeps()), false);
  });

  test('a background run of its own', async () => {
    const deps = wakeDeps({ backgroundRuns: (id) => id === 'track-1' });
    assert.equal(await hasWakeSource(session(), deps), true);
  });

  test('an open waitpoint it owns', async () => {
    const deps = wakeDeps({ openWaitpoints: async (id, channel) => (id === 'track-1' && channel === 'web:track-1' ? 1 : 0) });
    assert.equal(await hasWakeSource(session(), deps), true);
  });

  test('a lead with a running, waiting or externally waiting worker; not with idle ones', async () => {
    for (const status of ['running', 'waiting', 'external'] as const) {
      const deps = wakeDeps({ isLead: () => true, team: async () => [worker('idle'), worker(status)] });
      assert.equal(await hasWakeSource(session(), deps), true, status);
    }
    const idle = wakeDeps({ isLead: () => true, team: async () => [worker('idle'), worker('error')] });
    assert.equal(await hasWakeSource(session(), idle), false);
  });

  test('a busy worker does not count for a session that is not a lead', async () => {
    let asked = false;
    const deps = wakeDeps({ team: async () => { asked = true; return [worker('running')]; } });
    assert.equal(await hasWakeSource(session(), deps), false);
    assert.equal(asked, false);
  });
});
