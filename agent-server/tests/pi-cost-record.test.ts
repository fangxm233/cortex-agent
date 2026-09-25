//
// The old file drove the deleted `facade._test.runWithAdapter` with an `AgentAdapter` built on the
// PI pool. The attempt seam is now `startAttempt`: it acquires the pooled engine itself, opens one
// run, and records the cost of every `cost_record` the foreground turn produces. The engine is the
// fake PI runtime (no process is ever spawned); the pool is the daemon singleton, localised here by
// replacing `domain/runs/engines.ts`'s `engines` with a `SessionEngines` over the fake adapter —
// `startAttempt` reaches that singleton, so it is the only place the backend can be scripted.

import { afterAll, afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import type { makeFakeRuntimeFactory } from './agent-adapter/pi-fake-runtime.js';
import { runRequestFixture, attemptFromFixture } from './run-request-fixture.js';
import { startAttempt } from '../src/domain/runs/attempt.js';
import type { SessionEngines } from '../src/domain/runs/engines.js';
import type { CostEntry } from '../src/domain/costs/cost-tracker.js';
import { costRepo } from '../src/store/cost-repo.js';

type FakeRuntimeFactory = ReturnType<typeof makeFakeRuntimeFactory>;

// `startAttempt` imports the module singleton, so the fake PI adapter has to be installed before
// that import resolves. The factory runs at module-evaluation time, which is exactly when the
// singleton is built.
const fixtures = vi.hoisted(() => ({
  fake: null as unknown as FakeRuntimeFactory,
  engines: null as unknown as SessionEngines,
}));

vi.mock('../src/domain/runs/engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/runs/engines.js')>();
  const { tmpdir: dir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdirSync: mkdir } = await import('node:fs');
  const { PIAdapter } = await import('../src/agent-adapter/pi/adapter.js');
  const { ClaudeAdapter } = await import('../src/agent-adapter/claude/adapter.js');
  const { makeFakeRuntimeFactory: makeFake } = await import('./agent-adapter/pi-fake-runtime.js');
  const sessionDir = join(dir(), `pi-cost-record-sessions-${process.pid}`);
  mkdir(sessionDir, { recursive: true });
  const fake = makeFake({ sessionId: 'pi-test-001' });
  fixtures.fake = fake;
  fixtures.engines = new actual.SessionEngines({
    pi: new PIAdapter(fake.factory, sessionDir),
    claude: new ClaudeAdapter(),
  });
  return { ...actual, engines: fixtures.engines };
});

// Temp costs file (isolated from production costs.json)
const COSTS_FILE = pathJoin(tmpdir(), `pi-cost-record-costs-${process.pid}.json`);
const ORIGINAL_COSTS_FILE = process.env['CORTEX_COSTS_FILE'];

// --- Cleanup (afterAll() ensures env is restored even on assertion failure) ---

afterAll(() => {
  if (ORIGINAL_COSTS_FILE !== undefined) {
    process.env['CORTEX_COSTS_FILE'] = ORIGINAL_COSTS_FILE;
  } else {
    delete process.env['CORTEX_COSTS_FILE'];
  }
  if (existsSync(COSTS_FILE)) {
    unlinkSync(COSTS_FILE);
  }
  // Reset the singleton so the next test file gets a clean state
  costRepo._testReset();
});

afterEach(async () => {
  for (const key of fixtures.engines.listKeys()) await fixtures.engines.close(key);
});

// ---------------------------------------------------------------------------
// Integration test: one PI attempt → one cost entry with provider/model/tokens
// ---------------------------------------------------------------------------

test('pi-cost-record: agent_end records cost before the foreground result settles', async () => {
  // Redirect cost tracking to isolated temp file
  process.env['CORTEX_COSTS_FILE'] = COSTS_FILE;
  costRepo._testReset();

  const fake = fixtures.fake;
  const runtimeIndex = fake.runtimes.length;
  const sessionKey = `pi-cost-${runtimeIndex}`;
  const partial = { piProvider: 'anthropic', promptText: 'hello', sessionKey };
  const attemptOverride = { backend: 'pi' as const, mode: 'api' };

  // startAttempt acquires the pooled engine synchronously and opens the run; the PI runtime
  // resolves a moment later, exactly as the old `adapter.spawn()` did.
  const run = startAttempt({
    request: runRequestFixture(
      { ...partial, project: 'pi-cost-test', trigger: 'test' },
      attemptOverride,
    ),
    attempt: attemptFromFixture(partial, attemptOverride),
    executionId: null,
    onEvent: () => {},
  });

  // The session announces itself once its runtime resolved and hands PI the opening prompt.
  const runtime = await fake.runtime(runtimeIndex);
  await runtime.nextCall('prompt');

  // agent_end records low-level usage; agent_settled terminates the Cortex turn.
  runtime.emitAgentStart();
  runtime.emitAgentEnd({
    provider: 'anthropic',
    model: 'claude-opus-4',
    usage: { input: 200, output: 100, cacheRead: 20, cacheWrite: 10, cost: { total: 0.005 } },
  });

  // Wait for the attempt to finish processing.
  await run.foreground;
  // Drain any pending async cost writes (`recordCost` is fire-and-forget in the attempt event loop).
  await costRepo.flush();
  run.kill();

  // --- Assertions ---

  assert.ok(existsSync(COSTS_FILE), 'costs file should exist after cost_record was processed');
  const raw = readFileSync(COSTS_FILE, 'utf8');
  const lines = raw.trim().split('\n').filter(l => l).map(l => JSON.parse(l) as CostEntry);
  assert.ok(lines.length > 0, 'costs file should have at least one entry (JSONL format)');
  const piEntries = lines.filter(e => e.backend === 'pi');
  assert.equal(piEntries.length, 1, 'exactly one PI cost entry should be recorded (no double-recording)');

  const entry = piEntries[0];
  assert.equal(entry.backend, 'pi', 'backend should be pi');
  assert.equal(entry.provider, 'anthropic', 'provider should be anthropic');
  assert.equal(entry.model, 'claude-opus-4', 'model should match agent_end message');
  assert.equal(entry.input_tokens, 200, 'input_tokens should match usage.input');
  assert.equal(entry.output_tokens, 100, 'output_tokens should match usage.output');
  assert.equal(entry.prompt_tokens, 230, 'prompt total includes both cache token categories');
  assert.equal(entry.cache_read_tokens, 20, 'cache reads preserve the provider report');
  assert.equal(entry.cache_creation_tokens, 10, 'cache writes preserve the provider report');
  assert.equal(entry.provider_requests, 1, 'one assistant request was observed');
  assert.ok(
    Math.abs((entry.cost_usd ?? 0) - 0.005) < 0.0001,
    `cost_usd should be ~0.005, got ${entry.cost_usd}`,
  );
  assert.equal(entry.project, 'pi-cost-test', 'project should match the request context');
  assert.equal(entry.trigger, 'test', 'trigger should match the request context');
  assert.equal(entry.mode, 'api', 'mode should come from the attempt config');
  assert.equal(entry.source, 'estimate', 'the attempt records an estimated cost source');
});

// ---------------------------------------------------------------------------
// Integration test: a subagent's spend reaches the ledger as its own entry
// ---------------------------------------------------------------------------

test('pi-cost-record: a subagent files its own entry and joins the turn cost', async () => {
  process.env['CORTEX_COSTS_FILE'] = COSTS_FILE;
  costRepo._testReset();

  const fake = fixtures.fake;
  const runtimeIndex = fake.runtimes.length;
  const sessionKey = `pi-cost-${runtimeIndex}`;
  const partial = { piProvider: 'openai-codex', promptText: 'delegate it', sessionKey };
  const attemptOverride = { backend: 'pi' as const, mode: 'api' };

  const run = startAttempt({
    request: runRequestFixture(
      { ...partial, project: 'pi-subagent-cost-test', trigger: 'test' },
      attemptOverride,
    ),
    attempt: attemptFromFixture(partial, attemptOverride),
    executionId: null,
    onEvent: () => {},
  });

  const runtime = await fake.runtime(runtimeIndex);
  await runtime.nextCall('prompt');
  runtime.emitAgentStart();
  // The Agent tool raises this once the child ends, mid-turn — before the parent settles.
  runtime.emit({
    type: 'cortex_subagent_usage',
    report: {
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      usage: {
        input: 300, output: 120, cacheRead: 40, cacheWrite: 0,
        cost: 0.25, contextTokens: 460, turns: 2,
      },
    },
  });
  runtime.emitAgentEnd({
    provider: 'openai-codex',
    model: 'gpt-5-codex',
    usage: { input: 20, output: 10, cost: { total: 0.5 } },
  });

  const result = await run.foreground;
  await costRepo.flush();
  run.kill();

  const entries = readFileSync(COSTS_FILE, 'utf8')
    .trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as CostEntry)
    .filter(entry => entry.project === 'pi-subagent-cost-test');

  assert.equal(entries.length, 2, 'the child and the parent each file one entry');
  const child = entries.find(entry => entry.input_tokens === 300);
  assert.ok(child, 'the child filed an entry of its own');
  assert.equal(child.provider, 'openai-codex');
  assert.equal(child.model, 'gpt-5-codex');
  assert.equal(child.output_tokens, 120);
  assert.equal(child.prompt_tokens, 340, 'prompt total includes the cache reads');
  assert.equal(child.cache_read_tokens, 40);
  assert.equal(child.provider_requests, 2, 'two assistant messages inside the child');
  assert.ok(Math.abs((child.cost_usd ?? 0) - 0.25) < 0.0001);
  assert.ok(
    Math.abs((result.total_cost_usd ?? 0) - 0.75) < 0.0001,
    `turn cost should include the child's spend, got ${result.total_cost_usd}`,
  );
});
