// input:  Vitest, a stub PI extension API, spawner and UI context
// output: quota-notice emission, source resolution and throttle-arrival assertions
// pos:    Covers the PI provider quota path from child probe to throttle
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import quotaProbe from '../src/agent-adapter/pi/quota-probe.js';
import { decodeQuotaNotice } from '../src/domain/costs/codex-quota.js';
import { reportCodexQuota, resolveQuotaSource } from '../src/agent-adapter/pi/quota-sink.js';
import { PIAdapter } from '../src/agent-adapter/pi/adapter.js';
import {
  initRateLimitThrottle, getThrottleState, _testReset,
  type RateLimitThrottleState,
} from '../src/domain/costs/rate-limit-throttle.js';
import { MockAdapter } from '../src/platform/testing.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const CODEX_HEADERS: Record<string, string> = {
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': '93',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-at': '1786160107',
};

type Handler = (event: unknown, ctx: unknown) => unknown;

function stubPi() {
  const handlers = new Map<string, Handler>();
  return {
    api: { on: (event: string, handler: Handler) => handlers.set(event, handler), registerTool() {} },
    fire(event: string, payload: unknown, ctx: unknown) {
      const handler = handlers.get(event);
      assert.ok(handler, `no handler registered for ${event}`);
      return handler(payload, ctx);
    },
    registered: () => [...handlers.keys()],
  };
}

function stubCtx() {
  const sent: string[] = [];
  return { sent, ctx: { ui: { notify: (message: string) => { sent.push(message); } } } };
}

test('reports the quota it read off a codex response', () => {
  const pi = stubPi();
  quotaProbe(pi.api as never);
  assert.deepEqual(pi.registered(), ['after_provider_response']);

  const { sent, ctx } = stubCtx();
  pi.fire('after_provider_response', { status: 200, headers: CODEX_HEADERS }, ctx);

  assert.equal(sent.length, 1);
  assert.deepEqual(decodeQuotaNotice(sent[0]), {
    provider: 'openai-codex',
    planType: 'pro',
    windows: [{ type: 'seven_day', utilization: 0.93, resetsAt: 1786160107 }],
  });
});

test('reports quota from a failed response too, since the headers still carry it', () => {
  const pi = stubPi();
  quotaProbe(pi.api as never);
  const { sent, ctx } = stubCtx();
  pi.fire('after_provider_response', { status: 429, headers: CODEX_HEADERS }, ctx);
  assert.equal(sent.length, 1);
});

test('stays silent for a provider that advertises no quota', () => {
  const pi = stubPi();
  quotaProbe(pi.api as never);
  const { sent, ctx } = stubCtx();
  pi.fire('after_provider_response', { status: 200, headers: { 'content-type': 'text/event-stream' } }, ctx);
  assert.deepEqual(sent, []);
});

test('never lets a reporting failure escape into the turn', () => {
  const pi = stubPi();
  quotaProbe(pi.api as never);
  const brokenCtx = { ui: { notify: () => { throw new Error('rpc closed'); } } };
  pi.fire('after_provider_response', { status: 200, headers: CODEX_HEADERS }, brokenCtx);
});

test('tolerates a context with no UI channel', () => {
  const pi = stubPi();
  quotaProbe(pi.api as never);
  pi.fire('after_provider_response', { status: 200, headers: CODEX_HEADERS }, {});
});

test('ignores an event whose headers are missing or malformed', () => {
  const pi = stubPi();
  quotaProbe(pi.api as never);
  const { sent, ctx } = stubCtx();
  pi.fire('after_provider_response', { status: 200 }, ctx);
  pi.fire('after_provider_response', { status: 200, headers: 'nope' }, ctx);
  assert.deepEqual(sent, []);
});

// --- server side: the reading reaches the throttle under the keys dispatch gates on ---

const READING = {
  provider: 'openai-codex' as const,
  planType: 'pro',
  windows: [
    { type: 'seven_day', utilization: 0.96, resetsAt: 1786160107 },
    { type: 'five_hour', utilization: 0.91, resetsAt: 1785823070 },
  ],
};

test('submits one throttle event per window, keeping utilization and reset intact', async () => {
  const calls: unknown[] = [];
  await reportCodexQuota(READING, { provider: 'openai-codex', displayName: 'OpenAI Codex', mode: 'openai-codex' },
    async (info, source) => { calls.push({ info, source }); });

  assert.deepEqual(calls, [
    {
      info: { rateLimitType: 'seven_day', utilization: 0.96, resetsAt: 1786160107 },
      source: { provider: 'openai-codex', displayName: 'OpenAI Codex', mode: 'openai-codex' },
    },
    {
      info: { rateLimitType: 'five_hour', utilization: 0.91, resetsAt: 1785823070 },
      source: { provider: 'openai-codex', displayName: 'OpenAI Codex', mode: 'openai-codex' },
    },
  ]);
});

test('attributes the reading to the profile provider, not the name the headers used', async () => {
  const calls: { source: unknown }[] = [];
  await reportCodexQuota(READING, { provider: 'my-codex', displayName: 'my-codex', mode: 'api' },
    async (_info, source) => { calls.push({ source }); });
  assert.deepEqual(new Set(calls.map((c) => (c.source as { provider: string }).provider)), new Set(['my-codex']));
});

function stubSpawner() {
  const children: { stdout: PassThrough }[] = [];
  const spawn = () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    children.push(child as unknown as { stdout: PassThrough });
    return { process: child as never };
  };
  return { spawn: spawn as never, children };
}

async function waitForThrottle(attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    if (getThrottleState().providers.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a quota notice from the PI child throttles the provider it was routed under', async (t) => {
  t.onTestFinished(() => _testReset());
  let saved: RateLimitThrottleState | null = null;
  await initRateLimitThrottle(
    new MockAdapter({ adminChannel: 'mock-admin' }) as never,
    { save: async (state) => { saved = state; }, load: async () => saved },
  );

  const stub = stubSpawner();
  const adapter = new PIAdapter(stub.spawn);
  adapter.spawn({
    sessionId: null,
    sessionKey: 'quota-wire',
    resume: false,
    piProvider: 'openai-codex',
    piGatewayPath: '/m/openai-codex/openai-codex',
    piGatewayBaseUrl: 'http://127.0.0.1:9880',
  });

  const reading = {
    provider: 'openai-codex',
    planType: 'pro',
    windows: [{ type: 'seven_day', utilization: 0.96, resetsAt: Math.floor(Date.now() / 1000) + 3600 }],
  };
  stub.children[0].stdout.write(`${JSON.stringify({
    type: 'extension_ui_request',
    id: 'q1',
    method: 'notify',
    message: `cortex:provider-quota:${JSON.stringify(reading)}`,
  })}\n`);

  await waitForThrottle();
  const state = getThrottleState();
  assert.deepEqual(state.providers.map((p) => p.provider), ['openai-codex']);
  assert.deepEqual(state.providers[0].modes, ['openai-codex']);
  assert.deepEqual(state.providers[0].windows.map((w) => w.type), ['seven_day']);
});

test('resolves the provider and mode that the dispatch gate looks up', () => {
  assert.deepEqual(
    resolveQuotaSource({ piProvider: 'openai-codex', piGatewayPath: '/m/openai-codex/openai-codex' }),
    { provider: 'openai-codex', displayName: 'OpenAI Codex', mode: 'openai-codex' },
  );
  // A profile with a mode distinct from the provider name still routes by mode.
  assert.equal(
    resolveQuotaSource({ piProvider: 'openai-codex', piGatewayPath: '/m/sol-overflow/openai-codex' }).mode,
    'sol-overflow',
  );
  // No mode on the profile → spawn-config omits the gateway path → the gate reads 'api'.
  assert.equal(resolveQuotaSource({ piProvider: 'openai-codex' }).mode, 'api');
  // No provider on the profile → resolveRateLimitProvider falls back to the backend name.
  assert.equal(resolveQuotaSource({}).provider, 'pi');
});
