// input:  a frozen trial policy, a container monotonic clock and a recording transport
// output: document composition, control-route delivery, auth and refusal contracts
// pos:    Lease echo writer unit tests
// >>> If I am updated, update my header and folder CORTEX.md <<<

import '../../_test-home.js';
import assert from 'node:assert/strict';
import { it } from 'vitest';

import {
  composeLeaseEcho,
  LEASE_ECHO_SCHEMA_VERSION,
  LeaseEchoRefused,
  leaseEchoUrl,
  publishLeaseEcho,
  type LeaseEchoTransportResponse,
} from '../../../src/domain/benchmark/lease-echo.js';
import type { ResolvedTrialPolicy } from '../../../src/domain/benchmark/resolved-policy.js';

const COMPILED_AT_EPOCH_MS = 1_800_000_000_000;
const BUDGET_MS = 1_800_000;
const ORIGIN_NS = 5_000_000_000n;

function policy(overrides: Partial<ResolvedTrialPolicy> = {}): ResolvedTrialPolicy {
  return {
    trial_id: 'trial-echo',
    deadline: {
      compiled_at_epoch_ms: COMPILED_AT_EPOCH_MS,
      absolute_epoch_ms: COMPILED_AT_EPOCH_MS + BUDGET_MS,
      monotonic_origin_ns: ORIGIN_NS,
    },
    credential: {
      proxy_base_url: 'http://127.0.0.1:9931/',
      dummy_token_ref: 'dummy-token-ref',
    },
    ...overrides,
  } as unknown as ResolvedTrialPolicy;
}

function elapsed(ms: number): bigint {
  return ORIGIN_NS + BigInt(ms) * 1_000_000n;
}

interface RecordedPost {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function recordingTransport(response: LeaseEchoTransportResponse, sink: RecordedPost[]) {
  return async (url: string, headers: Record<string, string>, body: string) => {
    sink.push({ url, headers, body });
    return response;
  };
}

function accepted(armedRemainingMs: number): LeaseEchoTransportResponse {
  return {
    status: 200,
    body: JSON.stringify({
      ok: true, lease_state: 'reconciled', armed_remaining_ms: armedRemainingMs,
    }),
  };
}

it('composes the document from the container clocks alone', () => {
  const document = composeLeaseEcho(policy(), elapsed(120_000));

  assert.deepEqual(document, {
    schema_version: LEASE_ECHO_SCHEMA_VERSION,
    trial_id: 'trial-echo',
    compiled_at_epoch_ms: COMPILED_AT_EPOCH_MS,
    absolute_epoch_ms: COMPILED_AT_EPOCH_MS + BUDGET_MS,
    remaining_ms: BUDGET_MS - 120_000,
  });
});

it('reads no host clock, so the same monotonic instant always yields the same document', () => {
  const first = composeLeaseEcho(policy(), elapsed(1_000));
  const second = composeLeaseEcho(policy(), elapsed(1_000));

  assert.deepEqual(first, second);
});

it('never reports a negative remaining budget', () => {
  const document = composeLeaseEcho(policy(), elapsed(BUDGET_MS + 60_000));

  assert.equal(document.remaining_ms, 0);
});

it('posts to the control route with the same bearer a model call presents', async () => {
  const posts: RecordedPost[] = [];
  const result = await publishLeaseEcho(policy(), {
    monotonic_ns: () => elapsed(30_000),
    post: recordingTransport(accepted(BUDGET_MS - 30_000), posts),
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'http://127.0.0.1:9931/_cortex/lease-echo');
  assert.equal(posts[0].headers.authorization, 'Bearer dummy-token-ref');
  assert.equal(posts[0].headers['content-type'], 'application/json');
  assert.equal(JSON.parse(posts[0].body).remaining_ms, BUDGET_MS - 30_000);
  assert.deepEqual(result, {
    ok: true, lease_state: 'reconciled', armed_remaining_ms: BUDGET_MS - 30_000,
  });
});

it('sends no host absolute instant, only container instants and a duration', async () => {
  const posts: RecordedPost[] = [];
  await publishLeaseEcho(policy(), {
    monotonic_ns: () => elapsed(30_000),
    post: recordingTransport(accepted(0), posts),
  });

  assert.deepEqual(Object.keys(JSON.parse(posts[0].body)).sort(), [
    'absolute_epoch_ms', 'compiled_at_epoch_ms', 'remaining_ms', 'schema_version', 'trial_id',
  ]);
});

it('builds the control-route url without doubling the base separator', () => {
  assert.equal(leaseEchoUrl('http://host:1/'), 'http://host:1/_cortex/lease-echo');
  assert.equal(leaseEchoUrl('http://host:1'), 'http://host:1/_cortex/lease-echo');
});

it('surfaces the proxy refusal reason rather than reporting a silent success', async () => {
  const refusal = publishLeaseEcho(policy(), {
    monotonic_ns: () => elapsed(0),
    post: async () => ({ status: 409, body: JSON.stringify({ error: 'lease_echo_duplicate' }) }),
  });

  await assert.rejects(refusal, (error: unknown) => {
    assert.ok(error instanceof LeaseEchoRefused);
    assert.equal(error.status, 409);
    assert.equal(error.reason, 'lease_echo_duplicate');
    return true;
  });
});

it('reports a clamped lease as the anomaly it is rather than as a plain success', async () => {
  const result = await publishLeaseEcho(policy(), {
    monotonic_ns: () => elapsed(0),
    post: async () => ({
      status: 200,
      body: JSON.stringify({ ok: true, lease_state: 'clamped', armed_remaining_ms: 42 }),
    }),
  });

  assert.equal(result.lease_state, 'clamped');
});
