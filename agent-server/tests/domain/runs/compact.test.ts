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
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import type { ClaudeRoute } from '../../../src/domain/connections/claude-route.js';
import type { EngineSpec } from '../../../src/agent-adapter/types.js';
import { PIAdapter } from '../../../src/agent-adapter/pi/adapter.js';
import { makeFakeRuntimeFactory } from '../../agent-adapter/pi-fake-runtime.js';
import { piPool } from '../../agent-adapter/pi-pool-fixture.js';

function selection(overrides: Partial<EngineSelection> = {}): EngineSelection {
  return {
    backend: 'pi', model: 'deepseek-chat', connection: null, provider: 'anthropic', thinking: null,
    ...overrides,
  };
}

/** What the orchestration hands compaction: the request the session's next turn would run under. */
function target(selectionOverrides: Partial<EngineSelection> = {}): CompactAgentTarget {
  return {
    backend: 'pi',
    request: {
      runId: 'compact-run',
      session: {
        sessionId: 'track-1', backendSessionId: 'backend-1', engineKey: 'web:track-1', },
      selection: selection(selectionOverrides),
      spec: bareSpec(),
      prompt: { text: '' },
      context: {
        channel: 'web:track-1', project: 'nimbus', trigger: 'manual-compact', routeTrigger: 'user',
        executionKind: 'local', isUserInitiated: true,
      },
      policy: {
        background: 'none', recordCost: false, hooks: true, loadRules: true, mcpComposition: 'direct',
        captureTranscripts: true,
      },
    },
  };
}

test('support depends only on backend capability', () => {
  assert.equal(isSessionCompactionSupported({ backend: 'pi' }), true);
  assert.equal(isSessionCompactionSupported({ backend: 'claude' }), true);
  assert.equal(isSessionCompactionSupported({ backend: 'unknown' }), false);
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
    route: (attempt) => {
      calls.push(['route', attempt.model]);
      return { connection: 'relay', baseUrl: 'http://relay.invalid', sets: {}, unsets: ['ANTHROPIC_API_KEY'] };
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
    assert.equal(acquiredSpec!.route.anthropicBaseUrl, 'http://relay.invalid');
    // The route is asked for the selection's first attempt, as the run would open it.
    assert.deepEqual(calls.filter((entry) => entry[0] === 'route'), [['route', 'deepseek-chat']]);
    // A PI spawn never inherits Claude's routing variables, whatever route it was handed.
    assert.deepEqual(acquiredSpec!.env.unsets,
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']);

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
        backend: 'pi', connection: 'anthropic', source: 'estimate',
        input_tokens: 100, output_tokens: 10, provider: 'anthropic', model: 'deepseek-chat',
      }],
    );
  } finally {
    pool.kill('web:track-1');
  }
});

test('compactAgentContext rejects a selection whose backend is not the session’s, before acquiring an engine', async () => {
  let acquired = false;
  await assert.rejects(
    () => compactAgentContext(
      target({ backend: 'claude' }),
      {
        acquireEngine: () => { acquired = true; throw new Error('must not acquire'); },
        route: () => undefined,
        recordCost: async () => {},
      },
    ),
    /does not support manual context compaction/i,
  );
  assert.equal(acquired, false);
});

const SELECTED: EngineSelection = {
  model: 'deepseek-reasoner', backend: 'pi', connection: null, provider: 'anthropic', thinking: null,
};

/** PI has no Claude route, exactly as `resolveRunRoute` answers for it. */
function routeOf(_attempt: EngineSelection): ClaudeRoute | undefined {
  return undefined;
}

test('compaction reuses the selected engine in place', async () => {
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
  const { request } = target(SELECTED);
  const live = engines.acquire(buildEngineSpec(request, SELECTED, { route: routeOf(SELECTED) }));
  const costs: unknown[] = [];
  try {
    const result = await compactAgentContext({ backend: 'pi', request }, {
      acquireEngine: (spec) => engines.acquire(spec),
      route: routeOf,
      recordCost: async (entry) => { costs.push(entry); },
    });
    assert.equal(result.status, 'compacted');
    assert.equal(engines.get('web:track-1'), live, 'the live engine was compacted in place, not retired');
    assert.deepEqual(fake.requests.map((r) => r.model), ['deepseek-reasoner'], 'no primary engine was opened');
    assert.equal((await fake.runtime()).calls.filter((call) => call.kind === 'compact').length, 1);
    // The cost is the attempt's that did the work.
    assert.deepEqual(costs, [{
      project: 'nimbus', trigger: 'manual-compact', cost_usd: 0.1, backend: 'pi', connection: 'anthropic',
      source: 'estimate', input_tokens: 100, output_tokens: 10, provider: 'anthropic', model: 'deepseek-reasoner',
    }]);
  } finally {
    engines.kill('web:track-1');
  }
});

test('with no engine live, compaction asks only for the selection', async () => {
  const acquired: EngineSpec[] = [];
  await compactAgentContext(target(), {
    acquireEngine: (spec) => {
      acquired.push(spec);
      return { compact: async () => ({ status: 'not-needed', usage: null }) } as never;
    },
    route: routeOf,
    recordCost: async () => {},
  });
  assert.deepEqual(acquired.map((spec) => spec.model.id), ['deepseek-chat']);
});
