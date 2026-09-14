//
// These cases used to ride `facade.runAgent`'s decorator chain. That chain is gone: the pre-flight
// gate (`shouldSkipAttempt`), the provider attribution (`attemptProvider`) and the fallback walk now
// live in `domain/runs/run.ts` over `domain/runs/fallback.ts`, and a caller opens a run with
// `startRun`. The evidence case belongs here too: a run blocked before its attempt spawns must not
// freeze an attempt identity or open a journal.
//
// Rate-limit-throttle is a mutable module singleton, so the suite binds its private CORTEX_HOME via
// `loadThrottleHome` before any module that imports the throttle is loaded (all runtime imports
// below are dynamic for exactly that reason). `_testReset()` between tests prevents leakage.

import { afterAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentResult } from '../src/core/types/agent-types.js';
import type { RunRequest, RunObserver } from '../src/domain/runs/request.js';
import type { RunEvent } from '../src/domain/runs/events.js';
import type { RunAttempt } from '../src/domain/runs/attempt.js';
import { loadThrottleHome } from './runs/throttle-fixture.js';

const attempt = vi.hoisted(() => ({ startAttempt: vi.fn() }));

// The provider-attribution facts this suite asserts now live on the run, above the attempt seam:
// `AgentRunImpl.attribute()` stamps a result that named no provider, and `attributeError()` stamps
// a retryable thrown error. Intercept `startAttempt` so a synthetic attempt can hand the run an
// unattributed outcome without spawning a backend; the run owns the assertions' subject.
vi.mock('@domain/runs/attempt.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, startAttempt: attempt.startAttempt };
});

const home = await loadThrottleHome('run-preflight-gates-test');
const { resolveRateLimitProvider } = await import(
  '../src/domain/agents/provider-run-lifecycle.js'
);
const { resolveProfileConfig } = await import('../src/domain/agents/profile-manager.js');
const { startRun } = await import('../src/domain/runs/service.js');
const { runRequestFixture } = await import('./run-request-fixture.js');

afterAll(() => home.dispose());

/** A run request around one of the fixture profiles (the profile itself IS its first attempt). */
function requestFor(profileName: string, overrides: Partial<RunRequest> = {}): RunRequest {
  const base = runRequestFixture({
    channel: 'web:rate-limit', profileName, project: 'general', trigger: 'user',
    promptText: 'hello',
  });
  return { ...base, profile: resolveProfileConfig(profileName), ...overrides };
}

function collector(): { observer: RunObserver; events: RunEvent[] } {
  const events: RunEvent[] = [];
  return { observer: { onEvent: (event) => { events.push(event); } }, events };
}

// --- pre-flight evidence gate ---

test('evidence-enabled preflight rate limit creates no attempt evidence and keeps the refusal result', async (t) => {
  const rl = await home.initThrottle(['plan']);
  const identity = await import('../src/domain/benchmark/production-attempt-identity.js');
  const journals = await import('../src/domain/benchmark/production-attempt-journal.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'run-preflight-evidence-'));
  const identityStorePath = path.join(root, 'data', 'benchmark-attempt-identities.jsonl');
  const journalStorePath = path.join(root, 'data', 'benchmark-attempt-journals.jsonl');
  const journalDir = path.join(root, 'data', 'benchmark-attempt-journals');
  identity.initializeProductionAttemptIdentity({ storePath: identityStorePath });
  t.onTestFinished(() => {
    identity.resetProductionAttemptIdentity();
    journals.resetProductionAttemptJournals();
    rl._testReset();
    rmSync(root, { recursive: true, force: true });
  });

  const run = startRun(requestFor('scan', {
    benchmark: {
      evidenceContext: {
        schema_version: 'cortex-production-benchmark-evidence-context/1',
        trial_id: 'trial-preflight', root_run_id: 'root-preflight',
        bundle_manifest_hash: 'a'.repeat(64),
        model_execution: {
          model_alias_policy: { policy: 'exact' }, cli_name: 'claude',
          cli_version: 'claude-fixture-1', max_output_tokens: null,
        },
      },
      identityDirective: '', rootThreadId: 'thr-preflight', parentThreadId: null,
      templateName: 'benchmark-direct', agentSlotId: 'benchmark-direct', stage: null,
      preserveUnreportedAccounting: false,
    },
  }), []);

  const result = await run.settled;
  assert.equal(result.rateLimited, true);
  assert.equal(result.sessionId, null);
  assert.equal(identity.getProductionAttemptIdentity(run.executionId), null);
  assert.equal(journals.getProductionAttemptJournal(run.executionId), null);
  assert.equal(existsSync(identityStorePath), false);
  assert.equal(existsSync(journalStorePath), false);
  assert.equal(existsSync(journalDir), false);
});

// --- the skip gate and its notice ---

test('a single-attempt run skips the engine when its mode is rate-limited and narrates the error', async (t) => {
  const rl = await home.initThrottle(['plan']);
  t.onTestFinished(() => rl._testReset());
  const { observer, events } = collector();
  const run = startRun(requestFor('scan'), [observer]);
  const result = await run.settled;

  assert.equal(result.rateLimited, true);
  assert.ok(result.rateLimitMessage?.includes('plan'));
  assert.equal(result.rateLimitProvider, 'anthropic');
  assert.equal(result.sessionId, null);
  // No engine was spawned: the only prose is the synthesized terminal card.
  assert.deepEqual(
    events
      .filter((event): event is Extract<RunEvent, { type: 'assistant_text' }> =>
        event.type === 'assistant_text')
      .map((event) => ({ text: event.text, level: event.noticeLevel })),
    [{ text: 'Rate limited', level: 'error' }],
  );
});

test('the fallback walk skips every rate-limited config, reports a transition per skip, and refuses when exhausted', async (t) => {
  // plan profile: mode=plan, fallback=[mode=api, mode=plan]. Rate-limit both plan and api — all
  // three attempt selections are skipped, so the last one reports the terminal refusal.
  const rl = await home.initThrottle(['plan', 'api']);
  t.onTestFinished(() => rl._testReset());
  const { observer, events } = collector();
  const run = startRun(requestFor('plan'), [observer]);
  const result = await run.settled;

  assert.equal(result.rateLimited, true);
  assert.ok(result.rateLimitMessage?.includes('plan'));
  assert.equal(result.rateLimitProvider, 'anthropic');
  assert.equal(result.sessionId, null);
  // onFallback used to be a facade callback; it is now the run stream's own event, one per
  // transition (3 configs → 2 transitions).
  assert.deepEqual(
    events
      .filter((event): event is Extract<RunEvent, { type: 'run_fallback' }> =>
        event.type === 'run_fallback')
      .map((event) => [event.from, event.to]),
    [
      ['claude-sonnet-4-6/plan', 'claude-sonnet-4-6/api'],
      ['claude-sonnet-4-6/api', 'claude-sonnet-4-6/plan'],
    ],
  );
});

// --- provider identity (pure) ---

test('provider identity accepts arbitrary configured providers and generic backend fallback', () => {
  assert.equal(resolveRateLimitProvider({ backend: 'pi', provider: 'provider-z' } as any), 'provider-z');
  assert.equal(resolveRateLimitProvider({ backend: 'custom-backend', provider: null } as any), 'custom-backend');
});

/** A synthetic attempt over an outcome the test chose: only the fields `AgentRunImpl` reads, so
 *  the run walks its own settle/attribute path without a backend. */
function attemptOutcome(foreground: Promise<AgentResult>): RunAttempt {
  return {
    engine: {
      backend: 'claude', capabilities: new Set(), backendSessionId: null,
      run: () => ({}), steer: () => ({ accepted: false }),
      ingestExternal: () => false, respondToDialog: () => false,
      compact: async () => ({}), close: async () => {}, kill: () => true,
    },
    engineRun: {}, spec: {}, backend: 'claude', identity: null,
    foreground, settled: foreground, backendSessionId: null, kill: () => true,
  } as unknown as RunAttempt;
}

test('the run stamps the attempt provider on an unattributed result and on a retryable error', async () => {
  home.rl._testReset();
  const providerProfile = { ...resolveProfileConfig('scan'), provider: 'provider-z' };
  const request = (): RunRequest => requestFor('scan', { profile: providerProfile });

  const baseResult: AgentResult = {
    sessionId: 's', total_cost_usd: 0, num_turns: 1,
    rateLimited: false, rateLimitMessage: null, planFilePath: null,
    enteredPlanMode: false, exitedPlanMode: false, finalOutput: null,
  };
  attempt.startAttempt.mockImplementationOnce(() => attemptOutcome(Promise.resolve(baseResult)));
  const success = startRun(request(), []);
  assert.equal((await success.settled).rateLimitProvider, 'provider-z');

  const error = new Error('rate limit exceeded');
  attempt.startAttempt.mockImplementationOnce(() => attemptOutcome(Promise.reject(error)));
  const failure = startRun(request(), []);
  await assert.rejects(failure.settled, (caught: any) => caught.rateLimitProvider === 'provider-z');
});
