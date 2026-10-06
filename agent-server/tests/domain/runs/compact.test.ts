import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  compactAgentContext,
  isSessionCompactionSupported,
  type CompactAgentDeps,
  type CompactAgentTarget,
} from '../../../src/domain/runs/compact.js';
import { bareSpec } from '../../../src/domain/runs/spec-loader.js';
import { buildEngineSpec } from '../../../src/domain/runs/engine-spec.js';
import { SessionEngines } from '../../../src/domain/runs/engines.js';
import type { RunAttemptConfig } from '../../../src/domain/agents/profile-manager.js';
import type { RunRequest } from '../../../src/domain/runs/request.js';
import type { EngineSpec } from '../../../src/agent-adapter/types.js';
import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import { makeFakeRuntimeFactory } from '../../agent-adapter/pi-fake-runtime.js';
import { piPool } from '../../agent-adapter/pi-pool-fixture.js';

function profile(overrides: Record<string, unknown> = {}): any {
  return {
    name: 'deepseek', backend: 'pi', model: 'deepseek-chat', mode: 'deepseek', provider: 'anthropic',
    fallback: [], extraEnv: {}, extraOption: {}, thinking: null,
    ...overrides,
  };
}

/** What the orchestration hands compaction: the request the session's next turn would run under. */
function target(profileOverrides: Record<string, unknown> = {}): CompactAgentTarget {
  return {
    backend: 'pi',
    request: {
      runId: 'compact-run',
      session: {
        sessionId: 'track-1', backendSessionId: 'backend-1', engineKey: 'web:track-1', sessionName: 'cortex-a1b2c3',
      },
      profile: profile(profileOverrides),
      spec: bareSpec(),
      prompt: { text: '' },
      context: {
        channel: 'web:track-1', project: 'nimbus', trigger: 'manual-compact', routeTrigger: 'user',
        executionKind: 'local', isUserInitiated: true, commissionMode: false,
      },
      policy: {
        background: 'none', recordCost: false, hooks: true, loadRules: true, mcpComposition: 'direct',
        captureTranscripts: true,
      },
    },
  };
}

test('support requires a profile whose backend matches the session’s', () => {
  assert.equal(isSessionCompactionSupported({ backend: 'pi', profileName: 'deepseek' }, () => profile()), true);
  assert.equal(isSessionCompactionSupported(
    { backend: 'claude', profileName: 'print' },
    () => profile({ backend: 'claude' }),
  ), true);
  assert.equal(isSessionCompactionSupported(
    { backend: 'pi', profileName: 'wrong' },
    () => profile({ backend: 'claude' }),
  ), false);
});

test('compactAgentContext resumes the channel’s pooled session, compacts without a turn, and records reported cost', async () => {
  const fake = makeFakeRuntimeFactory({
    compact: {
      summary: 'short summary', firstKeptEntryId: 'e1',
      tokensBefore: 100, estimatedTokensAfter: 20,
      usage: {
        input: 100, output: 10, cacheRead: 2, cacheWrite: 3, totalTokens: 115,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
      },
    },
  });
  const adapter = new PIAdapter(fake.factory);
  const pool = piPool(adapter);
  const calls: any[] = [];
  let acquiredSpec: EngineSpec | undefined;
  const deps: CompactAgentDeps = {
    acquireEngine: (spec) => {
      acquiredSpec = spec;
      calls.push(['acquire']);
      return pool.open(spec);
    },
    isPooled: () => false,
    route: (request, attempt) => {
      calls.push(['route', attempt.mode, request.context.routeTrigger]);
      return { ANTHROPIC_BASE_URL: 'http://gateway', ANTHROPIC_API_KEY: null };
    },
    recordCost: async (entry) => { calls.push(['cost', entry]); },
  };

  try {
    const result = await compactAgentContext(target(), deps);
    assert.equal(result.status, 'compacted');

    // The pool was asked for the SAME session the channel's next turn resumes into: same engine
    // key, same backend resume target, same per-spawn route a run would carry (deletes included).
    assert.equal(acquiredSpec!.resume.backendSessionId, 'backend-1');
    assert.equal(acquiredSpec!.resume.resume, true);
    assert.equal(acquiredSpec!.engineKey, 'web:track-1');
    assert.equal(acquiredSpec!.context.channel, 'web:track-1');
    assert.equal(acquiredSpec!.route.anthropicBaseUrl, 'http://gateway');
    // The route is asked for the profile's first attempt, as the run would open it.
    assert.deepEqual(calls.filter((entry) => entry[0] === 'route'), [['route', 'deepseek', 'user']]);
    assert.deepEqual(acquiredSpec!.env.unsets, ['ANTHROPIC_API_KEY']);

    // Compaction is a backend command, not a turn: the scripted session sees compact() and never
    // prompt(). (The old surface's throw-on-send stub is now a positive protocol assertion.)
    const runtime = await fake.runtime();
    assert.equal(runtime.calls.filter((call) => call.kind === 'compact').length, 1);
    assert.equal(runtime.calls.some((call) => call.kind === 'prompt'), false,
      'compaction must not open a conversational turn');

    // The session stays POOLED: the next turn of the channel reuses it rather than paying a spawn.
    assert.deepEqual(pool.listSessions(), ['web:track-1']);

    assert.deepEqual(
      calls.filter((entry) => entry[0] === 'cost').map((entry) => entry[1]),
      [{
        project: 'nimbus', trigger: 'manual-compact', cost_usd: 0.25,
        backend: 'pi', mode: 'deepseek', source: 'estimate',
        input_tokens: 100, output_tokens: 10, provider: 'anthropic', model: 'deepseek-chat',
      }],
    );
  } finally {
    pool.kill('web:track-1');
  }
});

test('compactAgentContext rejects a profile whose backend is not the session’s, before acquiring an engine', async () => {
  let acquired = false;
  await assert.rejects(
    () => compactAgentContext(
      target({ backend: 'claude' }),
      {
        acquireEngine: () => { acquired = true; throw new Error('must not acquire'); },
        isPooled: () => false,
        route: () => ({}),
        recordCost: async () => {},
      },
    ),
    /does not support manual context compaction/i,
  );
  assert.equal(acquired, false);
});

const FALLBACK = {
  model: 'deepseek-reasoner', backend: 'pi', mode: 'deepseek-backup', provider: 'anthropic',
} as RunAttemptConfig;

function routeOf(_request: RunRequest, attempt: RunAttemptConfig) {
  return { ANTHROPIC_BASE_URL: `http://gateway/${attempt.mode}`, ANTHROPIC_API_KEY: null };
}

test('compaction runs on the fallback engine the session\'s last turn left live', async () => {
  const fake = makeFakeRuntimeFactory({
    compact: {
      summary: 'short', firstKeptEntryId: 'e1', tokensBefore: 100, estimatedTokensAfter: 20,
      usage: {
        input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      },
    },
  });
  const engines = new SessionEngines({ pi: new PIAdapter(fake.factory) });
  const { request } = target({ fallback: [FALLBACK] });
  // The primary was rate-limited, so the turn ran on the fallback: a fresh backend conversation
  // under the session's engine key, opened the way the run opens a fallback attempt.
  const fallbackTurn = { ...request, session: { ...request.session, backendSessionId: null } };
  const live = engines.acquire(buildEngineSpec(fallbackTurn, FALLBACK, { route: routeOf(fallbackTurn, FALLBACK) }));
  const costs: unknown[] = [];
  try {
    const result = await compactAgentContext({ backend: 'pi', request }, {
      acquireEngine: (spec) => engines.acquire(spec),
      isPooled: (spec) => engines.reuses(spec),
      route: routeOf,
      recordCost: async (entry) => { costs.push(entry); },
    });
    assert.equal(result.status, 'compacted');
    assert.equal(engines.get('web:track-1'), live, 'the live engine was compacted in place, not retired');
    assert.deepEqual(fake.requests.map((r) => r.model), ['deepseek-reasoner'], 'no primary engine was opened');
    assert.equal((await fake.runtime()).calls.filter((call) => call.kind === 'compact').length, 1);
    // The cost is the attempt's that did the work.
    assert.deepEqual(costs, [{
      project: 'nimbus', trigger: 'manual-compact', cost_usd: 0.1, backend: 'pi', mode: 'deepseek-backup',
      source: 'estimate', input_tokens: 100, output_tokens: 10, provider: 'anthropic', model: 'deepseek-reasoner',
    }]);
  } finally {
    engines.kill('web:track-1');
  }
});

test('with no attempt\'s engine live, compaction asks for the primary', async () => {
  const acquired: EngineSpec[] = [];
  const crossBackend = { ...FALLBACK, backend: 'claude' } as RunAttemptConfig;
  await compactAgentContext(target({ fallback: [FALLBACK, crossBackend] }), {
    acquireEngine: (spec) => {
      acquired.push(spec);
      return { compact: async () => ({ status: 'not-needed', usage: null }) } as never;
    },
    // Only an engine on another backend is live: it is not this session's conversation.
    isPooled: (spec) => spec.backend.kind === 'claude',
    route: routeOf,
    recordCost: async () => {},
  });
  assert.deepEqual(acquired.map((spec) => spec.model.id), ['deepseek-chat']);
});
