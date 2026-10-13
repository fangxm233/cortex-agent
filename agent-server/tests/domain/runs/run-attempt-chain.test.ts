// The attempt chain, with each attempt scripted by hand: the run's own decisions (which attempt's
// events reach observers) are the subject, so the engine is replaced at the `startAttempt` seam.
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
  const attempt = { model: 'm1', backend: 'claude' as const, mode: 'plan', provider: null, extraEnv: {}, extraOption: {}, thinking: null };
  return {
    runId: 'run-chain',
    session: { sessionId: 's-1', backendSessionId: null, engineKey: 's-1'},
    profile: { name: 'p', ...attempt, fallback: [{ ...attempt, model: 'm2' }] },
    spec: {
      systemPrompt: null, directive: null, promptTemplate: null, tools: null, pluginDirs: [],
      mcp: { composition: 'direct', allowlist: null }, backendOptions: {},
    },
    prompt: { text: 'hi' },
    context: {
      channel: 'slack:C1', project: 'general', trigger: 'user', executionKind: 'local',
      isUserInitiated: true, commissionMode: false,
    },
    policy: {
      background: 'hold', recordCost: false, hooks: false, loadRules: false,
      mcpComposition: 'direct', captureTranscripts: false,
    },
  } as RunRequest;
}

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

test('events a retried attempt still streams never reach the run\'s observers', async () => {
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
  assert.equal(attempts.length, 2, 'the chain moved on to the fallback');

  attempts[0].emit({ type: 'assistant_text', text: 'late from the abandoned attempt', phase: 'background' });
  attempts[0].emit({ type: 'background_result', result: result({ num_turns: 7, total_cost_usd: 9 }) });
  attempts[1].emit({ type: 'assistant_text', text: 'from the fallback', phase: 'foreground' });
  attempts[1].settle(result({ finalOutput: 'fallback' }));
  const settled = await run.settled;

  assert.equal(settled.finalOutput, 'fallback');
  const texts = seen.flatMap((event) => (event.type === 'assistant_text' ? [event.text] : []));
  assert.deepEqual(texts, ['from the fallback']);
  assert.equal(seen.some((event) => event.type === 'background_result'), false);
  assert.equal(run.numTurns, 1, 'the abandoned attempt\'s tally is not the run\'s');
});
