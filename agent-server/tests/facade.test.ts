// input:  facade, throttle, temp profiles, MockAdapter
// output: provider identity, exact pre-flight, notice regressions
// pos:    Facade pre-flight policy tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Rate-limit-throttle is a mutable singleton (module-level state). The suite loads
// throttle and facade together after binding its private home, so both see the same
// instance. _testReset() before/after each test prevents leakage.

import { afterAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function writeProfilesFixture(home: string): void {
  const configDir = path.join(home, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
    defaultProfile: 'plan',
    profiles: {
      plan: {
        model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan',
        fallback: [
          { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'api' },
          { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
        ],
      },
      scan: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
    },
  }));
}

function restoreHome(previousHome: string | undefined): void {
  if (previousHome === undefined) delete process.env.CORTEX_HOME;
  else process.env.CORTEX_HOME = previousHome;
}

async function loadSuiteModules() {
  const { setProcessLogPolicy } = await import('../src/core/log.js');
  const restoreLogPolicy = setProcessLogPolicy({ consoleToStderr: false, files: false });
  try {
    const [testing, rl, facade, profiles] = await Promise.all([
      import('../src/platform/testing.js'),
      import('../src/domain/costs/rate-limit-throttle.js'),
      import('../src/domain/agents/facade.js'),
      import('../src/store/profile-repo.js'),
    ]);
    return { MockAdapter: testing.MockAdapter, rl, facade, profileRepo: profiles.profileRepo, restoreLogPolicy };
  } catch (error) {
    restoreLogPolicy();
    throw error;
  }
}

const previousCortexHome = process.env.CORTEX_HOME;
const suiteHome = mkdtempSync(path.join(os.tmpdir(), 'facade-test-'));
process.env.CORTEX_HOME = suiteHome;

let suiteModules;
try {
  writeProfilesFixture(suiteHome);
  suiteModules = await loadSuiteModules();
} catch (error) {
  restoreHome(previousCortexHome);
  rmSync(suiteHome, { recursive: true, force: true });
  throw error;
}

const { MockAdapter, rl, facade: facadeModule, profileRepo, restoreLogPolicy } = suiteModules;

// --- Helpers ---

async function getRl() {
  return rl;
}

async function getFacade() {
  return facadeModule;
}

afterAll(() => {
  try {
    rl._testReset();
    profileRepo.invalidate();
  } finally {
    restoreHome(previousCortexHome);
    rmSync(suiteHome, { recursive: true, force: true });
    restoreLogPolicy();
  }
});

/** Init throttle with one or more rate-limited modes, returning the rl module.
 *  handleRateLimitEvent only adds a mode on the extension path (resetsAt > current),
 *  so each mode gets a slightly later resetsAt. */
async function initThrottle(modes: string[]) {
  const rl = await getRl();
  rl._testReset();
  const adapter = new MockAdapter({ adminChannel: 'test-admin' });
  const persistence = {
    save: async () => {},
    load: async () => null as any,
  };
  await rl.initRateLimitThrottle(adapter, persistence);
  const baseReset = Math.floor(Date.now() / 1000) + 300; // 5 min in future
  for (let i = 0; i < modes.length; i++) {
    await rl.handleRateLimitEvent(
      { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: baseReset + i * 60 },
      { provider: 'anthropic', displayName: 'Anthropic', mode: modes[i] },
    );
  }
  return rl;
}

/// --- allConfigsRateLimited ---

test('allConfigsRateLimited returns false when not throttled', async (t) => {
  const rl = await getRl();
  rl._testReset();
  t.onTestFinished(() => rl._testReset());

  const facade = await getFacade();
  assert.equal(facade.allConfigsRateLimited('plan'), false);
  assert.equal(facade.allConfigsRateLimited('scan'), false);
  assert.equal(facade.allConfigsRateLimited(null), false);
});

test('allConfigsRateLimited returns true when all modes in profile are rate-limited', async (t) => {
  // plan profile: mode=plan, fallback=[{mode:api}, {mode:plan}]
  // Need plan and api both rate-limited
  const rl = await initThrottle(['plan', 'api']);
  t.onTestFinished(() => rl._testReset());

  const facade = await getFacade();
  assert.equal(facade.allConfigsRateLimited('plan'), true);
});

test('allConfigsRateLimited returns false when only some modes rate-limited', async (t) => {
  // plan profile: mode=plan, fallback=[api, plan]
  // Only rate-limit plan — api still available
  const rl = await initThrottle(['plan']);
  t.onTestFinished(() => rl._testReset());

  const facade = await getFacade();
  assert.equal(facade.allConfigsRateLimited('plan'), false);
});

test('allConfigsRateLimited returns false on unknown profile', async (t) => {
  await initThrottle(['plan']);
  const rl = await getRl();
  t.onTestFinished(() => rl._testReset());

  const facade = await getFacade();
  // Unknown profile — catch in resolveProfileConfig -> return false (conservative)
  assert.equal(facade.allConfigsRateLimited('nonexistent-profile'), false);
});

/// --- runAgent pre-flight skip ---

test('runAgent single-config path skips runAgentOnce when mode rate-limited', async (t) => {
  // scan profile has no fallback (single config, mode=plan)
  const rl = await initThrottle(['plan']);
  t.onTestFinished(() => rl._testReset());

  const facade = await getFacade();
  const notices: Array<{ text: string; level?: string }> = [];
  const handle = facade.runAgent('test', {
    profileName: 'scan',
    channel: 'web:rate-limit',
    onAssistantMessage: (text, _blockId, level) => notices.push({ text, level }),
  });
  const result = await handle.promise;

  assert.equal(result.rateLimited, true);
  assert.ok(result.rateLimitMessage?.includes('plan'));
  assert.equal(result.rateLimitProvider, 'anthropic');
  // No adapter was spawned — synthetic return
  assert.equal(result.sessionId, null);
  assert.deepEqual(notices, [{ text: 'Rate limited', level: 'error' }]);
});

test('runAgent fallback loop skips rate-limited configs and returns synthetic result when all exhausted', async (t) => {
  // plan profile: mode=plan, fallback=[mode=api, mode=plan]
  // Rate-limit both plan and api — all 3 configs skipped
  const rl = await initThrottle(['plan', 'api']);
  t.onTestFinished(() => rl._testReset());

  const facade = await getFacade();
  const handle = facade.runAgent('test', { profileName: 'plan' });
  const result = await handle.promise;

  assert.equal(result.rateLimited, true);
  // Last attempted mode was 'plan' (third config)
  assert.ok(result.rateLimitMessage?.includes('plan'));
  assert.equal(result.rateLimitProvider, 'anthropic');
  assert.equal(result.sessionId, null);
});

test('provider identity accepts arbitrary configured providers and generic backend fallback', async () => {
  const facade = await getFacade();
  assert.equal(facade._test.resolveRateLimitProvider({ backend: 'pi', provider: 'provider-z' } as any), 'provider-z');
  assert.equal(facade._test.resolveRateLimitProvider({ backend: 'custom-backend', provider: null } as any), 'custom-backend');
});

test('provider wrapper attributes results and retryable thrown errors', async () => {
  const facade = await getFacade();
  const baseResult = {
    sessionId: 's', total_cost_usd: 0, num_turns: 1,
    rateLimited: false, rateLimitMessage: null, planFilePath: null,
    enteredPlanMode: false, exitedPlanMode: false, finalOutput: null,
  };
  const wrappedResult = facade._test.withRateLimitProvider({
    promise: Promise.resolve(baseResult), kill: () => false, sessionId: 's',
  } as any, 'provider-z');
  assert.equal((await wrappedResult.promise).rateLimitProvider, 'provider-z');

  const error = new Error('rate limit exceeded');
  const wrappedError = facade._test.withRateLimitProvider({
    promise: Promise.reject(error), kill: () => false, sessionId: null,
  } as any, 'provider-z');
  await assert.rejects(wrappedError.promise, (caught: any) => caught.rateLimitProvider === 'provider-z');
});

test('runAgent fallback loop calls onFallback for each skipped config', async (t) => {
  const rl = await initThrottle(['plan', 'api']);
  t.onTestFinished(() => rl._testReset());

  const facade = await getFacade();
  const fallbackCalls: Array<{ current: any; next: any; result: any }> = [];

  const handle = facade.runAgent('test', {
    profileName: 'plan',
    onFallback: async (current, next, result) => {
      fallbackCalls.push({ current, next, result });
    },
  });
  await handle.promise;

  // 3 configs → 2 fallback transitions (skip from 0→1, skip from 1→2)
  assert.equal(fallbackCalls.length, 2);
  assert.equal(fallbackCalls[0].result, null); // no real result — synthetic skip
  assert.equal(fallbackCalls[1].result, null);
});

/// --- Attempt notice ordering (deferred API-error card) ---
//
// The Claude CLI surfaces a 429 as a synthetic assistant message ("API Error: ...") that
// arrives BEFORE the turn settles. Whether that text is a failure or merely a pause is only
// knowable at settle time, so the card is held until then.

const RATE_LIMIT_TEXT = "API Error: Server is temporarily limiting requests (not your usage limit) · This request would exceed your account's rate limit. Please try again later.";

function rateLimitError(): Error {
  return Object.assign(new Error(RATE_LIMIT_TEXT), { rateLimitProvider: 'anthropic' });
}

function makeTracker(facade: any, notices: Array<{ text: string; level?: string }>, extra: Record<string, unknown> = {}) {
  return new facade._test.AttemptNoticeTracker({
    channel: 'web:rate-limit',
    isUserInitiated: true,
    onAssistantMessage: (text: string, _blockId: string | undefined, level?: string) => notices.push({ text, level }),
    ...extra,
  });
}

test('a held rate-limit card is replaced by the auto-resume warning when the provider is throttled', async (t) => {
  const rl = await initThrottle(['plan']);
  t.onTestFinished(() => rl._testReset());
  const facade = await getFacade();

  const notices: Array<{ text: string; level?: string }> = [];
  const tracker = makeTracker(facade, notices);

  tracker.options.onAssistantMessage(RATE_LIMIT_TEXT, undefined, 'error');
  assert.deepEqual(notices, [], 'the card is held until the attempt settles');

  tracker.emitTerminalError(rateLimitError());

  assert.deepEqual(notices, [{
    text: 'Rate limited — this chat will resume automatically when the limit resets.',
    level: 'warning',
  }], 'a paused turn reports the resume promise, not the API error');
});

test('a held rate-limit card is emitted exactly once when the attempt fails terminally', async (t) => {
  const rl = await getRl();
  rl._testReset(); // no active throttle — nothing can promise a resume
  t.onTestFinished(() => rl._testReset());
  const facade = await getFacade();

  const notices: Array<{ text: string; level?: string }> = [];
  const tracker = makeTracker(facade, notices);

  tracker.options.onAssistantMessage(RATE_LIMIT_TEXT, undefined, 'error');
  tracker.emitTerminalError(rateLimitError());

  assert.deepEqual(notices, [{ text: RATE_LIMIT_TEXT, level: 'error' }]);
});

test('a fallback transition flushes the held card before the fallback warning', async (t) => {
  const rl = await getRl();
  rl._testReset();
  t.onTestFinished(() => rl._testReset());
  const facade = await getFacade();

  const notices: Array<{ text: string; level?: string }> = [];
  const tracker = makeTracker(facade, notices);

  tracker.options.onAssistantMessage(RATE_LIMIT_TEXT, undefined, 'error');
  await tracker.transitionToFallback(
    { model: 'm1', backend: 'claude', mode: 'plan' },
    { model: 'm2', backend: 'claude', mode: 'api' },
    null,
  );

  assert.deepEqual(notices, [
    { text: RATE_LIMIT_TEXT, level: 'error' },
    { text: 'Model fallback: m1/plan → m2/api.', level: 'warning' },
  ]);
});

test('withTerminalNotices flushes a held card when the turn recovers and succeeds', async (t) => {
  const rl = await getRl();
  rl._testReset();
  t.onTestFinished(() => rl._testReset());
  const facade = await getFacade();

  const notices: Array<{ text: string; level?: string }> = [];
  const tracker = makeTracker(facade, notices);
  tracker.options.onAssistantMessage(RATE_LIMIT_TEXT, undefined, 'error');

  const result = {
    sessionId: 's', total_cost_usd: 0, num_turns: 1, rateLimited: false, rateLimitMessage: null,
    planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: 'done',
  };
  const handle = facade._test.withTerminalNotices(
    { promise: Promise.resolve(result), kill: () => false, sessionId: 's' } as any,
    tracker,
  );
  await handle.promise;

  assert.deepEqual(notices, [{ text: RATE_LIMIT_TEXT, level: 'error' }]);
});
