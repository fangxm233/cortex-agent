// input:  Node test runner + aistatus GatewayServer
// output: /m/{mode}/ prefix + cache token/cost tests
// pos:    Verify gateway per-request mode and cache cost
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import { GatewayServer } from 'aistatus/gateway';
import { configure } from 'aistatus';

// Disable usage uploads so test data never reaches aistatus.cc dashboard
configure({ uploadEnabled: false });

function makeConfig(mode = 'api') {
  const endpointModes = {
      api: {
        anthropic: {
          name: 'anthropic',
          base_url: 'https://api.anthropic.com',
          auth_style: 'anthropic',
          keys: ['sk-test-api-key'],
          passthrough: false,
          fallbacks: [],
          model_fallbacks: {},
        },
      },
      plan: {
        anthropic: {
          name: 'anthropic',
          base_url: 'https://api.anthropic.com',
          auth_style: 'bearer',
          keys: [],
          passthrough: true,
          fallbacks: [],
          model_fallbacks: {},
        },
      },
  };
  return {
    host: '127.0.0.1',
    port: 0,  // OS-assigned
    status_check: false,
    mode,
    endpoints: endpointModes[mode],  // active mode's endpoints
    endpoint_modes: endpointModes,
  };
}

function request(port: number, method: string, path: string, body?: string): Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      timeout: 3000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

test('gateway /m/{mode}/ URL prefix selects per-request mode', async (t) => {
  const config = makeConfig('api');
  const gw = new GatewayServer(config);

  // The gateway should recognize /m/plan/... as per-request mode override
  // We test via /status and /health which don't use proxy — so test via the proxy path
  // Send a request to /m/plan/anthropic/v1/messages — it should resolve endpoints from 'plan' mode
  // Since we can't actually reach Anthropic, we expect it to at least route correctly (not 404)

  // Start gateway on random port
  const server = http.createServer((req, res) => {
    (gw as any)._handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  t.onTestFinished(() => {
    server.close();
  });

  // Test 1: /m/plan/anthropic/v1/messages should not return 404 "Unknown endpoint"
  // (it will fail with upstream connection error since we can't reach Anthropic, but not 404)
  const planRes = await request(port, 'POST', '/m/plan/anthropic/v1/messages',
    JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'test' }], max_tokens: 1 }));

  // Should NOT be 404 with "Unknown endpoint: m" — that would mean per-request mode isn't parsed
  if (planRes.status === 404) {
    const body = JSON.parse(planRes.body);
    assert.ok(!body.error?.message?.includes('Unknown endpoint'),
      `per-request mode path should not return "Unknown endpoint", got: ${body.error?.message}`);
  }

  // Test 2: /m/api/anthropic/v1/messages should also work
  const apiRes = await request(port, 'POST', '/m/api/anthropic/v1/messages',
    JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'test' }], max_tokens: 1 }));
  if (apiRes.status === 404) {
    const body = JSON.parse(apiRes.body);
    assert.ok(!body.error?.message?.includes('Unknown endpoint'),
      `per-request mode path should not return "Unknown endpoint", got: ${body.error?.message}`);
  }

  // Test 3: /m/invalid/anthropic/... should return 400 with unknown mode
  const invalidRes = await request(port, 'POST', '/m/invalid/anthropic/v1/messages',
    JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'test' }], max_tokens: 1 }));
  assert.equal(invalidRes.status, 400, 'invalid mode should return 400');
  const invalidBody = JSON.parse(invalidRes.body);
  assert.ok(invalidBody.error?.message?.includes('Unknown mode'),
    `should report unknown mode, got: ${invalidBody.error?.message}`);

  // Test 4: regular /anthropic/v1/messages still works (backward compat, uses global mode)
  const regularRes = await request(port, 'POST', '/anthropic/v1/messages',
    JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'test' }], max_tokens: 1 }));
  // Should not be "Unknown endpoint" 404
  if (regularRes.status === 404) {
    const body = JSON.parse(regularRes.body);
    assert.ok(!body.error?.message?.includes('Unknown endpoint'),
      'regular path should still work');
  }
});

test('gateway records cache tokens in usage', async (t) => {
  const config = makeConfig('api');
  const gw = new GatewayServer(config);

  // Simulate what _recordUsageIfPossible does with a response containing cache tokens
  const mockResponse = JSON.stringify({
    id: 'msg_test',
    type: 'message',
    model: 'claude-opus-4-6',
    usage: {
      input_tokens: 5000,
      output_tokens: 500,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 3000,
    },
  });

  const mockBackend = {
    id: 'anthropic:key:0',
    base_url: 'https://api.anthropic.com',
    api_key: 'sk-test',
    auth_style: 'anthropic',
    model_prefix: '',
    model_map: {},
    translate: null,
  };

  // Call _recordUsageIfPossible
  (gw as any)._recordUsageIfPossible(mockBackend, Buffer.from(mockResponse), 'claude-opus-4-6', 1000);

  // Check what was recorded
  const records = gw.usage.storage.read('all');
  assert.ok(records.length >= 1, 'should have recorded usage');

  const lastRecord = records[records.length - 1];
  assert.equal(lastRecord.in, 5000, 'input tokens should be recorded');
  assert.equal(lastRecord.out, 500, 'output tokens should be recorded');
  assert.equal(lastRecord.cache_read_in, 3000, 'cache read tokens should be recorded');
  assert.equal(lastRecord.cache_creation_in, 1000, 'cache creation tokens should be recorded');
});

test('gateway cost includes cache write and read fees', async (t) => {
  const config = makeConfig('api');
  const gw = new GatewayServer(config);

  // Anthropic Opus 4.6 pricing: $5/M input, $25/M output
  // Cache write: $5 × 1.25 = $6.25/M
  // Cache read:  $5 × 0.10 = $0.50/M
  //
  // Scenario: 1M input + 1M cache_creation + 1M cache_read + 1M output
  // Expected cost:
  //   input:          1M × $5    = $5.00
  //   cache creation: 1M × $6.25 = $6.25
  //   cache read:     1M × $0.50 = $0.50
  //   output:         1M × $25   = $25.00
  //   total: $36.75
  //
  // Without cache: input 1M × $5 + output 1M × $25 = $30.00 (misses $6.75)

  const mockResponse = JSON.stringify({
    model: 'claude-opus-4-6',
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    },
  });

  const mockBackend = {
    id: 'anthropic:key:0',
    base_url: 'https://api.anthropic.com',
    api_key: 'sk-test',
    auth_style: 'anthropic',
    model_prefix: '',
    model_map: {},
    translate: null,
  };

  (gw as any)._recordUsageIfPossible(mockBackend, Buffer.from(mockResponse), 'claude-opus-4-6', 500);

  const records = gw.usage.storage.read('all') as Array<{ cost: number }>;
  const lastRecord = records[records.length - 1];

  // Cost should be ~$36.75 (with cache), NOT $30.00 (without cache)
  assert.ok(lastRecord.cost > 30, `cost should be >$30 (includes cache fees), got: $${lastRecord.cost}`);
  assert.ok(Math.abs(lastRecord.cost - 36.75) < 0.01,
    `cost should be ~$36.75 with cache pricing, got: $${lastRecord.cost}`);
});
