import './_test-home.js'; // MUST be first — isolates paths before facade loads
// input:  agent facade compact helper with fake profile/adapter/cost deps
// output: support gating, resume spawn, compact, close, and cost assertions
// pos:    Backend-neutral manual compact facade tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  compactAgentContext,
  isSessionCompactionSupported,
  type CompactAgentDeps,
} from '../src/domain/agents/facade.js';

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

test('support is limited to PI and Claude print with a matching fixed profile', () => {
  assert.equal(isSessionCompactionSupported({ backend: 'pi', profileName: 'deepseek' }, () => profile()), true);
  assert.equal(isSessionCompactionSupported(
    { backend: 'claude', profileName: 'print' },
    () => profile({ backend: 'claude', claudeBackend: 'print' }),
  ), true);
  assert.equal(isSessionCompactionSupported(
    { backend: 'claude', profileName: 'tui' },
    () => profile({ backend: 'claude', claudeBackend: 'tui' }),
  ), false);
  assert.equal(isSessionCompactionSupported(
    { backend: 'pi', profileName: 'wrong' },
    () => profile({ backend: 'claude' }),
  ), false);
});

test('compactAgentContext resumes one native control process, closes it, and records reported cost', async () => {
  const calls: any[] = [];
  const process = {
    sessionKey: 'web:track-1', sessionId: 'backend-1', events: { async *[Symbol.asyncIterator]() {} },
    send: async () => { throw new Error('send must not be used'); },
    compact: async () => ({
      status: 'compacted' as const, tokensBefore: 100, estimatedTokensAfter: 20,
      contextUsage: null,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3, costUsd: 0.25 },
    }),
    close: async () => { calls.push(['close']); },
    kill: () => false,
  };
  const deps: CompactAgentDeps = {
    resolveProfile: () => profile(),
    getAdapter: () => ({
      backend: 'pi', capabilities: new Set(),
      spawn: (config: any) => { calls.push(['spawn', config]); return process as any; },
      close: async () => {}, kill: () => false, listSessions: () => [],
    }),
    configureMode: (mode, metadata) => { calls.push(['mode', mode, metadata]); return 'http://gateway'; },
    recordCost: async (entry) => { calls.push(['cost', entry]); },
  };

  const result = await compactAgentContext(REQUEST, deps);
  assert.equal(result.status, 'compacted');
  const spawn = calls.find((entry) => entry[0] === 'spawn')[1];
  assert.equal(spawn.sessionId, 'backend-1');
  assert.equal(spawn.resume, true);
  assert.equal(spawn.sessionKey, 'web:track-1');
  assert.equal(spawn.channel, 'web:track-1');
  assert.deepEqual(calls.filter((entry) => entry[0] === 'close'), [['close']]);
  assert.deepEqual(calls.find((entry) => entry[0] === 'cost')[1], {
    project: 'nimbus', trigger: 'manual-compact', cost_usd: 0.25,
    backend: 'pi', mode: 'deepseek', source: 'estimate',
    input_tokens: 100, output_tokens: 10, provider: 'anthropic', model: 'deepseek-chat',
  });
});

test('compactAgentContext rejects unsupported mode before spawning', async () => {
  let spawned = false;
  await assert.rejects(
    () => compactAgentContext(
      { ...REQUEST, backend: 'claude', profileName: 'tui' },
      {
        resolveProfile: () => profile({ backend: 'claude', claudeBackend: 'tui' }),
        getAdapter: () => { spawned = true; throw new Error('must not spawn'); },
        configureMode: () => undefined,
        recordCost: async () => {},
      },
    ),
    /does not support manual context compaction/i,
  );
  assert.equal(spawned, false);
});
