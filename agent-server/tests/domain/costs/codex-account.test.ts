import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import {
  HttpCodexAccountClient,
  parseCodexUsage,
  parseRedeemOutcome,
  parseResetCredits,
} from '../../../src/domain/costs/codex-account.js';

const NOW_MS = 1_790_000_000_000;
const CREDENTIALS = { token: 'tok-123', accountId: 'acct-9' };

const USAGE_BODY = {
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 99, limit_window_seconds: 604_800, reset_after_seconds: 513_733, reset_at: 1_792_115_610 },
    secondary_window: null,
  },
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
};

const CREDITS_BODY = {
  credits: [
    { id: 'credit-late', reset_type: 'codex_rate_limits', is_supported_by_plan: true, status: 'available',
      expires_at: '2026-11-20T00:00:00Z', title: 'Full reset' },
    { id: 'credit-used', reset_type: 'codex_rate_limits', is_supported_by_plan: true, status: 'redeemed',
      expires_at: '2026-11-01T00:00:00Z', title: 'Full reset' },
    { id: 'credit-early', reset_type: 'codex_rate_limits', is_supported_by_plan: true, status: 'available',
      expires_at: '2026-11-07T00:00:19Z', title: 'Full reset' },
    { id: 'credit-unsupported', reset_type: 'codex_rate_limits', is_supported_by_plan: false, status: 'available',
      expires_at: '2026-10-20T00:00:00Z', title: 'Full reset' },
  ],
  available_count: 2,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetch: typeof globalThis.fetch, credentials: typeof CREDENTIALS | null = CREDENTIALS) {
  return new HttpCodexAccountClient({
    credentials: async () => credentials,
    fetch,
    baseUrl: 'https://chatgpt.test/backend-api',
    now: () => NOW_MS,
    requestId: () => 'req-uuid-1',
  });
}

describe('Codex account parsing', () => {
  test('usage windows map like the response-header parser', () => {
    const parsed = parseCodexUsage({
      ...USAGE_BODY,
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_after_seconds: 600, reset_at: 0 },
        secondary_window: { used_percent: 7, limit_window_seconds: 604_800, reset_after_seconds: 1, reset_at: 1_790_500_000 },
      },
    }, NOW_MS);

    assert.deepEqual(parsed, {
      planType: 'prolite',
      windows: [
        { type: 'codex_primary', utilization: 0.42, resetsAt: NOW_MS / 1000 + 600 },
        { type: 'codex_secondary', utilization: 0.07, resetsAt: 1_790_500_000 },
      ],
      availableResets: 2,
    });
  });

  test('a usage response without any usable window is an error, not an empty reading', () => {
    assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: null } }, NOW_MS), /no rate-limit window/);
    assert.throws(() => parseCodexUsage({ rate_limit: {
      primary_window: { used_percent: 140, limit_window_seconds: 60, reset_at: 1 },
    } }, NOW_MS), /no rate-limit window/);
  });

  test('reset credits keep only spendable ones, earliest expiry first', () => {
    assert.deepEqual(parseResetCredits(CREDITS_BODY), {
      availableCount: 2,
      credits: [
        { id: 'credit-early', title: 'Full reset', expiresAt: Date.parse('2026-11-07T00:00:19Z') / 1000 },
        { id: 'credit-late', title: 'Full reset', expiresAt: Date.parse('2026-11-20T00:00:00Z') / 1000 },
      ],
    });
  });

  test.each(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'] as const)(
    'redeem outcome %s is typed',
    (code) => {
      assert.deepEqual(parseRedeemOutcome({ code, windows_reset: 1, credit: {} }), { status: code, cleared: [] });
    },
  );

  test('an unknown redeem outcome is an error', () => {
    assert.throws(() => parseRedeemOutcome({ code: 'pending' }), /unexpected result: pending/);
  });
});

describe('HttpCodexAccountClient', () => {
  test('reads usage and the credit list with the account headers', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/wham/usage') ? json(USAGE_BODY) : json(CREDITS_BODY)
    )) as unknown as typeof globalThis.fetch;

    const reading = await client(fetch).readUsage();

    assert.deepEqual(reading?.windows, [{ type: 'codex_primary', utilization: 0.99, resetsAt: 1_792_115_610 }]);
    assert.deepEqual(reading?.resetCredits?.credits.map((credit) => credit.id), ['credit-early', 'credit-late']);
    const calls = vi.mocked(fetch).mock.calls;
    assert.deepEqual(calls.map(([url]) => String(url)).sort(), [
      'https://chatgpt.test/backend-api/wham/rate-limit-reset-credits',
      'https://chatgpt.test/backend-api/wham/usage',
    ]);
    const headers = calls[0][1]?.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer tok-123');
    assert.equal(headers['chatgpt-account-id'], 'acct-9');
  });

  test('a failed credit list keeps the usage reading and its summary count', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith('/wham/usage') ? json(USAGE_BODY) : json({ error: 'nope' }, 500)
    )) as unknown as typeof globalThis.fetch;

    const reading = await client(fetch).readUsage();

    assert.deepEqual(reading?.resetCredits, { availableCount: 2, credits: [] });
  });

  test('a failed usage read is an error', async () => {
    const fetch = vi.fn(async () => json({}, 401)) as unknown as typeof globalThis.fetch;
    await assert.rejects(client(fetch).readUsage(), /HTTP 401/);
  });

  test('without a sign-in nothing is requested', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    assert.equal(await client(fetch, null).readUsage(), null);
    assert.equal(await client(fetch, null).redeemReset('credit-early'), null);
    assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  });

  test('redeem posts an idempotency key and the chosen credit', async () => {
    const fetch = vi.fn(async () => json({ code: 'reset', windows_reset: 1, credit: { status: 'redeemed' } })) as unknown as typeof globalThis.fetch;

    const outcome = await client(fetch).redeemReset('credit-early');

    assert.deepEqual(outcome, { status: 'reset', cleared: [] });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    assert.equal(String(url), 'https://chatgpt.test/backend-api/wham/rate-limit-reset-credits/consume');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { redeem_request_id: 'req-uuid-1', credit_id: 'credit-early' });
    assert.equal((init?.headers as Record<string, string>)['content-type'], 'application/json');
  });

  test('redeem without a credit lets the account choose', async () => {
    const fetch = vi.fn(async () => json({ code: 'no_credit', windows_reset: 0 })) as unknown as typeof globalThis.fetch;

    assert.deepEqual(await client(fetch).redeemReset(), { status: 'no_credit', cleared: [] });
    assert.deepEqual(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)), { redeem_request_id: 'req-uuid-1' });
  });
});
