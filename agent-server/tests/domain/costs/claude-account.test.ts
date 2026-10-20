import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import {
  HttpClaudeAccountClient,
  parseClaimOutcome,
  parseClaudeUsage,
  type ClaudeAccountCredentials,
} from '../../../src/domain/costs/claude-account.js';

const CREDENTIALS: ClaudeAccountCredentials = {
  headers: { authorization: 'Bearer tok-123', 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
  organizationUuid: 'org-1234',
  userAgent: 'claude-cli/2.1.280 (external, cli)',
};

function grant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, label: 'Usage reset', resets_total: 1, resets_left: 1,
    starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z',
    clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
    paused: false, usable_now: true, use_requires_limit: false, percent_used: 0, blocking: false, arm: 'a',
    ...overrides,
  };
}

const USAGE_BODY = {
  five_hour: { utilization: 42, resets_at: '2026-10-09T18:00:00Z' },
  seven_day: { utilization: 18.5, resets_at: null },
  seven_day_opus: null,
  cedar_ember: {
    eligible: true, ineligible_reason: null, at_limit: false, exhausted: false,
    grants: [
      grant('grant_late', { ends_at: '2026-11-20T00:00:00Z', resets_left: 2 }),
      grant('grant_paused', { paused: true }),
      grant('grant_spent', { resets_left: 0 }),
      grant('grant_later', { usable_now: false }),
      grant('grant_early', { ends_at: '2026-10-20T00:00:00Z', clears: ['five_hour'] }),
      grant('Bad Id!'),
    ],
    next_grant_id: 'grant_late',
    weekly_resets_at: null,
    cooldown_until: null,
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetch: typeof globalThis.fetch, credentials: ClaudeAccountCredentials | null = CREDENTIALS) {
  return new HttpClaudeAccountClient({
    credentials: async () => credentials,
    fetch,
    baseUrl: 'https://anthropic.test',
    requestId: () => 'req-uuid-1',
  });
}

const iso = (value: string) => Date.parse(value) / 1000;

describe('Claude account parsing', () => {
  test('windows convert percent to a fraction and usable grants become credits', () => {
    assert.deepEqual(parseClaudeUsage(USAGE_BODY), {
      windows: [
        { type: 'five_hour', utilization: 0.42, resetsAt: iso('2026-10-09T18:00:00Z') },
        { type: 'seven_day', utilization: 0.185, resetsAt: null },
      ],
      resetCredits: {
        availableCount: 3,
        atLimit: false,
        credits: [
          { id: 'grant_early', title: 'Usage reset', expiresAt: iso('2026-10-20T00:00:00Z'), clears: ['five_hour'], count: 1 },
          {
            id: 'grant_late', title: 'Usage reset', expiresAt: iso('2026-11-20T00:00:00Z'),
            clears: ['five_hour', 'seven_day', 'seven_day_overage_included'], count: 2,
          },
        ],
        nextCreditId: 'grant_late',
      },
    });
  });

  test('the account pick counts only when it names a usable grant', () => {
    const parsed = parseClaudeUsage({ ...USAGE_BODY, cedar_ember: { ...USAGE_BODY.cedar_ember, next_grant_id: 'grant_paused' } });
    assert.equal(parsed.resetCredits?.nextCreditId, undefined);
  });

  test('an account outside the reset program reports no credits rather than an error', () => {
    const parsed = parseClaudeUsage({ five_hour: USAGE_BODY.five_hour });
    assert.equal(parsed.resetCredits, null);
    const ineligible = parseClaudeUsage({
      ...USAGE_BODY,
      cedar_ember: { eligible: false, ineligible_reason: 'plan', at_limit: true, grants: [] },
    });
    assert.deepEqual(ineligible.resetCredits, { availableCount: 0, atLimit: true, credits: [] });
  });

  test('the model-scoped weekly limit becomes the labelled overage-included window', () => {
    const parsed = parseClaudeUsage({
      ...USAGE_BODY,
      limits: [
        { kind: 'weekly_all', percent: 91, resets_at: '2026-10-20T10:00:00Z', scope: null },
        { kind: 'weekly_scoped', percent: 50, resets_at: '2026-10-20T10:00:00Z', scope: { model: { id: null } } },
        { kind: 'weekly_scoped', percent: 16, resets_at: '2026-10-20T10:00:00Z', scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: 30, resets_at: null, scope: { model: { display_name: 'Other' } } },
      ],
    });
    assert.deepEqual(parsed.windows.slice(2), [
      { type: 'seven_day_overage_included', label: 'Fable', utilization: 0.16, resetsAt: iso('2026-10-20T10:00:00Z') },
    ]);
  });

  test('missing or malformed limits leave only the account windows', () => {
    for (const limits of [undefined, null, 'x', [{ kind: 'weekly_scoped', percent: 140, scope: { model: { display_name: 'Fable' } } }]]) {
      assert.equal(parseClaudeUsage({ ...USAGE_BODY, limits }).windows.length, 2);
    }
  });

  test('a usage response without any usable window is an error', () => {
    assert.throws(() => parseClaudeUsage({ five_hour: null, seven_day: { utilization: 140 } }), /no rate-limit window/);
    assert.throws(() => parseClaudeUsage([]), /not an object/);
  });

  test.each([
    ['reset', 'reset'],
    ['already_used', 'already_redeemed'],
    ['not_limited', 'nothing_to_reset'],
    ['cooldown', 'cooldown'],
    ['ineligible', 'ineligible'],
    ['unavailable', 'no_credit'],
  ] as const)('claim result %s maps to %s', (result, status) => {
    assert.deepEqual(parseClaimOutcome({ result, reason: null, cleared: ['five_hour'] }), { status, cleared: ['five_hour'] });
  });

  test('an unknown claim result is an error', () => {
    assert.throws(() => parseClaimOutcome({ result: 'pending' }), /unexpected result: pending/);
    assert.throws(() => parseClaimOutcome({ result: 'toString' }), /unexpected result: toString/);
  });
});

describe('HttpClaudeAccountClient', () => {
  test("reads usage with Claude's login headers and Claude Code's identity", async () => {
    const fetch = vi.fn(async () => json(USAGE_BODY)) as unknown as typeof globalThis.fetch;

    const reading = await client(fetch).readUsage();

    assert.equal(reading?.resetCredits?.availableCount, 3);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    assert.equal(String(url), 'https://anthropic.test/api/oauth/usage?cedar_ember=1&skip_spend=1');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.deepEqual(init?.headers, {
      ...CREDENTIALS.headers, 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.280 (external, cli)',
    });
  });

  test.each([
    [429, /rate limited \(HTTP 429\)/],
    [401, /authorization failed \(HTTP 401\)/],
    [403, /authorization failed \(HTTP 403\)/],
    [500, /HTTP 500/],
  ])('HTTP %i is an error', async (status, message) => {
    const fetch = vi.fn(async () => json({}, status)) as unknown as typeof globalThis.fetch;
    await assert.rejects(client(fetch).readUsage(), message);
  });

  test('without a Claude login nothing is requested', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    assert.equal(await client(fetch, null).readUsage(), null);
    assert.equal(await client(fetch, null).redeemReset('grant_late'), null);
    assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  });

  test('a claim names the program, the grant and an idempotency key', async () => {
    const fetch = vi.fn(async () => json({
      result: 'reset', reason: null, resets_left: 0, cleared: ['five_hour', 'seven_day'],
      weekly_resets_at: null, cooldown_until: null,
    })) as unknown as typeof globalThis.fetch;

    const outcome = await client(fetch).redeemReset('grant_late');

    assert.deepEqual(outcome, { status: 'reset', cleared: ['five_hour', 'seven_day'] });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    assert.equal(String(url), 'https://anthropic.test/api/organizations/org-1234/reset_rate_limits');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { program: 'cedar_ember', grant_id: 'grant_late', request_id: 'req-uuid-1' });
    assert.equal((init?.headers as Record<string, string>)['user-agent'], 'claude-cli/2.1.280 (external, cli)');
  });

  test('a claim without a grant or with a malformed one is never sent', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    assert.deepEqual(await client(fetch).redeemReset(), { status: 'no_credit', cleared: [] });
    await assert.rejects(client(fetch).redeemReset('../grant'), /Invalid Claude reset grant/);
    assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  });

  test('a rate-limited claim is an error, not a spent reset', async () => {
    const fetch = vi.fn(async () => json({}, 429)) as unknown as typeof globalThis.fetch;
    await assert.rejects(client(fetch).redeemReset('grant_late'), /reset request was rate limited/);
  });
});
