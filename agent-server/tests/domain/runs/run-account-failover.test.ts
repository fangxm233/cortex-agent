// A run whose login is rate-limited starts on another login when account failover is on — the
// session's selection untouched, the switch announced on its first run only — and is exactly what
// it was before when the switch is off. The throttle and the settings are the real ones; only the
// provider's logins are injected (the catalog and the credential store are not under test here).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResult } from '../../../src/core/types/agent-types.js';
import type { RunAttempt } from '../../../src/domain/runs/attempt.js';
import type { RunEvent } from '../../../src/domain/runs/events.js';
import type { RunRequest } from '../../../src/domain/runs/request.js';
import { loadThrottleHome } from './throttle-fixture.js';

const attempt = vi.hoisted(() => ({ startAttempt: vi.fn() }));

vi.mock('@domain/runs/attempt.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, startAttempt: attempt.startAttempt };
});

vi.mock('@domain/runs/account-failover.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/domain/runs/account-failover.js')>();
  const deps = { logins: () => ['subscription', 'school'], billingOf: () => 'subscription' };
  return {
    ...original,
    preflightFailover: (selection: Parameters<typeof original.preflightFailover>[0]) => original.preflightFailover(selection, deps),
    loginLabel: (selection: { connection: string | null }) => `login:${selection.connection}`,
  };
});

const home = await loadThrottleHome('run-account-failover-test');
const { updateSettings } = await import('../../../src/core/settings.js');
const { startRun } = await import('../../../src/domain/runs/service.js');
const { _resetFailoverAnnouncements } = await import('../../../src/domain/runs/account-failover.js');
const { runRequestFixture } = await import('../../run-request-fixture.js');
const { writeConnections } = await import('../../../src/core/connections-file.js');
writeConnections([{ id: 'school', backend: 'claude', type: 'account', label: 'School' }]);

afterAll(() => home.dispose());
beforeEach(() => {
  attempt.startAttempt.mockReset();
  attempt.startAttempt.mockImplementation(() => attemptOutcome());
  _resetFailoverAnnouncements();
});
afterEach(() => updateSettings({ accountFailover: false }));

const DONE: AgentResult = {
  sessionId: 's', total_cost_usd: 0, num_turns: 1, rateLimited: false, rateLimitMessage: null,
  planFilePath: null, enteredPlanMode: false, exitedPlanMode: false, finalOutput: 'ok',
};

function attemptOutcome(): RunAttempt {
  const foreground = Promise.resolve(DONE);
  return {
    engine: {
      backend: 'claude', backendSessionId: null, run: () => ({}), steer: () => ({ accepted: false }),
      ingestExternal: () => false, respondToDialog: () => false, compact: async () => ({}),
      close: async () => {}, kill: () => true,
    },
    engineRun: {}, spec: {}, backend: 'claude', identity: null,
    foreground, settled: foreground, backendSessionId: null, kill: () => true,
  } as unknown as RunAttempt;
}

function request(isUserInitiated: boolean, channel = 'web:failover'): RunRequest {
  return runRequestFixture(
    { channel, project: 'general', trigger: 'user', promptText: 'hello', isUserInitiated },
    { backend: 'claude', provider: null, model: 'claude-sonnet-4-6', connection: 'subscription' },
  );
}

async function run(req: RunRequest) {
  const events: RunEvent[] = [];
  const handle = startRun(req, [{ onEvent: (event) => { events.push(event); } }]);
  const result = await handle.settled.catch((error: unknown) => error as AgentResult);
  const started = attempt.startAttempt.mock.calls.at(-1)?.[0] as { attempt: { connection: string } } | undefined;
  const notices = events.filter((event) => event.type === 'assistant_text' && (event as { noticeLevel?: string }).noticeLevel === 'info');
  return { handle, result, started: attempt.startAttempt.mock.calls.length > 0 ? started : undefined, notices };
}

describe('with account failover off', () => {
  it('blocks background work on a limited login and runs a person\'s turn on it, as before', async () => {
    await home.initThrottle(['subscription']);
    const background = await run(request(false));
    expect(background.started).toBeUndefined();
    expect(background.result.rateLimited).toBe(true);
    const own = await run(request(true));
    expect(own.started?.attempt.connection).toBe('subscription');
    expect(own.notices).toEqual([]);
  });
});

describe('with account failover on', () => {
  beforeEach(() => updateSettings({ accountFailover: true }));

  it('starts background work on a free login instead of blocking it', async () => {
    await home.initThrottle(['subscription']);
    const background = await run(request(false));
    expect(background.started?.attempt.connection).toBe('school');
    expect(background.handle.request.selection.connection).toBe('subscription');
    expect(background.handle.attempt.config.connection).toBe('school');
  });

  it('switches a person\'s turn too, announcing the switch on its first run only', async () => {
    await home.initThrottle(['subscription']);
    const first = await run(request(true));
    const second = await run(request(true));
    expect([first.started?.attempt.connection, second.started?.attempt.connection]).toEqual(['school', 'school']);
    expect(first.notices).toHaveLength(1);
    expect(JSON.stringify(first.notices[0])).toMatch(/login:subscription.*login:school/);
    expect(second.notices).toEqual([]);
  });

  it('goes back to the session\'s own login once it recovers, and announces a later switch again', async () => {
    await home.initThrottle(['subscription']);
    await run(request(true));
    home.rl._testReset();
    const back = await run(request(true));
    expect(back.started?.attempt.connection).toBe('subscription');
    await home.initThrottle(['subscription']);
    expect((await run(request(true))).notices).toHaveLength(1);
  });

  it('waits as before when every login is limited', async () => {
    await home.initThrottle(['subscription', 'school']);
    const background = await run(request(false));
    expect(background.started).toBeUndefined();
    expect((await run(request(true))).started?.attempt.connection).toBe('subscription');
  });
});
