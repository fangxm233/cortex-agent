// Single-attempt lifecycle, scripted at the startAttempt seam.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

import type { RunEvent } from '../../../src/domain/runs/events.js';
import type { RunObserver, RunRequest, RunResult } from '../../../src/domain/runs/request.js';
import { RunRegistry } from '../../../src/core/run-registry.js';

interface ScriptedAttempt {
  emit(event: RunEvent): void;
  resolveForeground(result: RunResult): void;
  settle(result: RunResult): void;
}

const attempts = vi.hoisted(() => [] as ScriptedAttempt[]);

vi.mock('../../../src/domain/runs/attempt.js', () => ({
  startAttempt: (input: { onEvent(event: RunEvent): void; attempt: { backend: string } }) => {
    let resolveForeground!: (result: RunResult) => void;
    let resolveSettled!: (result: RunResult) => void;
    const foreground = new Promise<RunResult>((resolve) => { resolveForeground = resolve; });
    const settled = new Promise<RunResult>((resolve) => { resolveSettled = resolve; });
    attempts.push({
      emit: (event) => input.onEvent(event),
      resolveForeground,
      settle: (result) => { resolveForeground(result); resolveSettled(result); },
    });
    return {
      engine: {
        backendSessionId: null, steer: () => ({ accepted: false }), ingestExternal: () => false,
        respondToDialog: () => false, kill: () => true,
      },
      engineRun: {}, spec: { resume: { resume: false, backendSessionId: null } },
      backend: input.attempt.backend, identity: null,
      foreground, settled, backendSessionId: null, kill: () => true,
    };
  },
}));

const { AgentRunImpl } = await import('../../../src/domain/runs/run.js');

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    sessionId: 'b-1', total_cost_usd: 0, num_turns: 1, rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: 'ok',
    ...overrides,
  } as RunResult;
}

function request(): RunRequest {
  const attempt = { model: 'm1', backend: 'claude' as const, mode: 'plan', provider: null, thinking: null };
  return {
    runId: 'run-chain',
    session: { sessionId: 's-1', backendSessionId: null, engineKey: 's-1'},
    selection: attempt,
    spec: {
      systemPrompt: null, directive: null, promptTemplate: null, tools: null, pluginDirs: [],
      mcp: { composition: 'direct', allowlist: null }, backendOptions: {},
    },
    prompt: { text: 'hi' },
    context: {
      channel: 'slack:C1', project: 'general', trigger: 'user', executionKind: 'local',
      isUserInitiated: true,
    },
    policy: {
      background: 'hold', recordCost: false, hooks: false, loadRules: false,
      mcpComposition: 'direct', captureTranscripts: false,
    },
  } as RunRequest;
}

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

test('a rate-limited foreground never opens a second attempt and keeps its background stream', async () => {
  const seen: RunEvent[] = [];
  const observer: RunObserver = { onEvent: (event) => { seen.push(event); } };
  const run = new AgentRunImpl({
    request: request(), observers: [observer], executionId: 'exec-chain',
    registry: new RunRegistry(), onTerminal: () => {}, startedAt: Date.now(),
  });
  run.start();

  // Attempt 0 is rate-limited; under `hold` its stream outlives that result.
  attempts[0].resolveForeground(result({ rateLimited: true, rateLimitMessage: 'limit' }));
  await tick();
  assert.equal(attempts.length, 1, 'rate limits cannot change the selected engine');
  attempts[0].emit({ type: 'assistant_text', text: 'background output', phase: 'background' });
  attempts[0].emit({ type: 'background_result', result: result({ num_turns: 7, total_cost_usd: 9 }) });
  attempts[0].settle(result({ rateLimited: true, finalOutput: 'limited', num_turns: 7 }));
  const settled = await run.settled;
  assert.equal(settled.finalOutput, 'limited');
  assert.equal(run.status, 'rate-limited');
  assert.equal(run.attempt.index, 0);
  assert.equal(seen.some(event => event.type === 'background_result'), true);
  assert.equal(seen.some(event => event.type === 'assistant_text' && event.text === 'background output'), true);
});
