import '../_test-home.js'; // MUST be first — isolates paths before the run layer loads

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  compactAgentContext,
  isSessionCompactionSupported,
  type CompactAgentDeps,
} from '../../src/domain/runs/compact.js';
import type { EngineSpec } from '../../src/agent-adapter/types.js';
import { PIAdapter } from '../../src/agent-adapter/pi/adapter.js';
import { makeFakeRuntimeFactory } from '../agent-adapter/pi-fake-runtime.js';
import { piPool } from '../agent-adapter/pi-pool-fixture.js';

const REQUEST = {
  sessionId: 'track-1',
  backend: 'pi' as const,
  backendSessionId: 'backend-1',
  channel: 'web:track-1',
  profileName: 'deepseek',
  projectId: 'nimbus',
  sessionName: 'cortex-a1b2c3',
};

function profile(overrides: Record<string, unknown> = {}): any {
  return {
    name: 'deepseek', backend: 'pi', model: 'deepseek-chat', mode: 'deepseek', provider: 'anthropic',
    fallback: [], extraEnv: {}, extraOption: {}, claudeBackend: undefined, thinking: null,
    ...overrides,
  };
}

test('support requires a profile whose backend matches the session’s', () => {
  assert.equal(isSessionCompactionSupported({ backend: 'pi', profileName: 'deepseek' }, () => profile()), true);
  assert.equal(isSessionCompactionSupported(
    { backend: 'claude', profileName: 'print' },
    () => profile({ backend: 'claude', claudeBackend: 'print' }),
  ), true);
  // A profile still configured `claudeBackend: 'tui'` runs the print path — the TUI runtime was
  // retired (D9) — so it compacts like any other Claude profile.
  assert.equal(isSessionCompactionSupported(
    { backend: 'claude', profileName: 'tui' },
    () => profile({ backend: 'claude', claudeBackend: 'tui' }),
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
    resolveProfile: () => profile(),
    acquireEngine: (spec) => {
      acquiredSpec = spec;
      calls.push(['acquire']);
      return pool.open(spec);
    },
    configureMode: (mode, metadata) => {
      calls.push(['mode', mode, metadata]);
      return { ANTHROPIC_BASE_URL: 'http://gateway', ANTHROPIC_API_KEY: null };
    },
    recordCost: async (entry) => { calls.push(['cost', entry]); },
  };

  try {
    const result = await compactAgentContext(REQUEST, deps);
    assert.equal(result.status, 'compacted');

    // The pool was asked for the SAME session the channel's next turn resumes into: same engine
    // key, same backend resume target, same per-spawn route a run would carry (deletes included).
    assert.equal(acquiredSpec!.resume.backendSessionId, 'backend-1');
    assert.equal(acquiredSpec!.resume.resume, true);
    assert.equal(acquiredSpec!.engineKey, 'web:track-1');
    assert.equal(acquiredSpec!.context.channel, 'web:track-1');
    assert.equal(acquiredSpec!.route.anthropicBaseUrl, 'http://gateway');
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
      { ...REQUEST, backend: 'pi', profileName: 'wrong' },
      {
        resolveProfile: () => profile({ backend: 'claude' }),
        acquireEngine: () => { acquired = true; throw new Error('must not acquire'); },
        configureMode: () => ({}),
        recordCost: async () => {},
      },
    ),
    /does not support manual context compaction/i,
  );
  assert.equal(acquired, false);
});
