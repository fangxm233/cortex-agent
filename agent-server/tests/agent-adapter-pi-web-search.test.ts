// input:  PI WebSearch tool, stubbed provider HTTP responses
// output: WebSearch dispatch, terminal, and mislabeled SSE tests
// pos:    PI WebSearch response validation regression coverage
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { webSearchTool } from '../src/agent-adapter/pi/web-search.js';

const QUERY = 'current stable runtime release';
const SOURCE_URL = 'https://docs.example.test/releases/current';

interface StubContextOptions {
  api: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  authHeaders?: Record<string, string>;
  modelHeaders?: Record<string, string>;
  authError?: string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeContext(options: StubContextOptions): any {
  const model = {
    id: 'search-model',
    api: options.api,
    provider: options.provider ?? `provider-${options.api}`,
    baseUrl: options.baseUrl ?? 'https://gateway.example.test/root',
    headers: options.modelHeaders,
    maxTokens: 4096,
  };
  return {
    model,
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async (requestedModel: unknown) => {
        assert.equal(requestedModel, model);
        if (options.authError) return { ok: false, error: options.authError };
        return {
          ok: true,
          apiKey: options.apiKey ?? 'test-api-key',
          headers: options.authHeaders,
        };
      }),
    },
  };
}

function executeSearch(ctx: any, params: Record<string, unknown> = { query: QUERY }) {
  return webSearchTool.execute('tc-web-search', params as any, undefined, undefined, ctx);
}

function sseEventsResponse(events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
    'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function successfulResponseEvents(
  text: string,
  url: string,
  query = QUERY,
): Record<string, unknown>[] {
  return [
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.output_item.done',
      item: { type: 'web_search_call', action: { type: 'search', query } },
    },
    {
      type: 'response.output_text.annotation.added',
      annotation: { type: 'url_citation', title: 'Release documentation', url },
    },
  ];
}

function sseResponse(text: string, url: string, query = QUERY): Response {
  return sseEventsResponse([
    ...successfulResponseEvents(text, url, query),
    { type: 'response.completed', response: { status: 'completed' } },
  ]);
}

function jsonResponsesPayload(status?: string): Record<string, unknown> {
  return {
    ...(status ? { status } : {}),
    output: [
      { type: 'web_search_call', action: { type: 'search', query: QUERY } },
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'The current release is 24.1.0.',
          annotations: [{ type: 'url_citation', url: SOURCE_URL }],
        }],
      },
    ],
  };
}

function encodeJwt(accountId: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`;
}

test('dispatches anthropic-messages through model.baseUrl and returns source URLs', async () => {
  const ctx = makeContext({
    api: 'anthropic-messages',
    provider: 'anthropic-compatible-a',
    baseUrl: 'https://gateway.example.test/anthropic/',
    authHeaders: { 'x-proxy-token': 'proxy-secret' },
    modelHeaders: { 'x-model-header': 'model-value' },
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'runtime release status' } },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: 'Release documentation', url: SOURCE_URL },
          { type: 'web_search_result', title: 'Duplicate', url: SOURCE_URL },
        ],
      },
      { type: 'text', text: 'The current release is 24.1.0.' },
    ],
  }), { headers: { 'content-type': 'application/json' } }));

  const result = await executeSearch(ctx, {
    query: QUERY,
    allowed_domains: ['docs.example.test'],
    blocked_domains: ['archive.example.test'],
  });

  assert.equal(fetchSpy.mock.calls[0][0], 'https://gateway.example.test/anthropic/v1/messages');
  const init = fetchSpy.mock.calls[0][1] as RequestInit;
  const headers = new Headers(init.headers);
  assert.equal(headers.get('x-api-key'), 'test-api-key');
  assert.equal(headers.get('x-proxy-token'), 'proxy-secret');
  assert.equal(headers.get('x-model-header'), 'model-value');
  assert.match(headers.get('user-agent') ?? '', /cortex/i);
  const body = JSON.parse(String(init.body));
  assert.equal(body.model, 'search-model');
  assert.deepEqual(body.tools, [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
    allowed_domains: ['docs.example.test'],
    blocked_domains: ['archive.example.test'],
  }]);
  assert.match(result.content[0].text, /current release is 24\.1\.0/i);
  assert.match(result.content[0].text, /Queries:\n- runtime release status/);
  assert.equal(result.content[0].text.match(new RegExp(SOURCE_URL, 'g'))?.length, 1);
});

test('uses bearer authentication for Anthropic OAuth tokens', async () => {
  const oauthToken = 'sk-ant-oat-test-token';
  const ctx = makeContext({
    api: 'anthropic-messages',
    provider: 'anthropic-oauth-compatible',
    apiKey: oauthToken,
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    content: [
      { type: 'server_tool_use', input: { query: 'oauth search query' } },
      { type: 'web_search_tool_result', content: [{ url: SOURCE_URL }] },
      { type: 'text', text: 'Authenticated search result.' },
    ],
  }), { headers: { 'content-type': 'application/json' } }));

  await executeSearch(ctx);

  const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
  assert.equal(headers.get('authorization'), `Bearer ${oauthToken}`);
  assert.equal(headers.has('x-api-key'), false);
});

test.each([
  ['openai-responses', 'authorization', 'Bearer test-api-key'],
  ['azure-openai-responses', 'api-key', 'test-api-key'],
])('dispatches %s through the Responses endpoint', async (api, authHeader, authValue) => {
  const ctx = makeContext({
    api,
    provider: `responses-compatible-${api}`,
    baseUrl: 'https://gateway.example.test/openai/',
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    sseResponse('The current release is 24.1.0.', SOURCE_URL),
  );

  const result = await executeSearch(ctx, {
    query: QUERY,
    allowed_domains: ['docs.example.test'],
  });

  assert.equal(fetchSpy.mock.calls[0][0], 'https://gateway.example.test/openai/responses');
  const init = fetchSpy.mock.calls[0][1] as RequestInit;
  assert.equal(new Headers(init.headers).get(authHeader), authValue);
  const body = JSON.parse(String(init.body));
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.match(body.input[0].content[0].text, /Only use these domains: docs\.example\.test/);
  assert.match(result.content[0].text, /current release is 24\.1\.0/i);
  assert.match(result.content[0].text, /Queries:\n- current stable runtime release/);
  assert.match(result.content[0].text, new RegExp(SOURCE_URL));
});

test('dispatches openai-codex-responses with account and beta headers', async () => {
  const accountId = 'acct-test-123';
  const ctx = makeContext({
    api: 'openai-codex-responses',
    provider: 'codex-compatible-a',
    baseUrl: 'https://subscription-gateway.example.test/backend/',
    apiKey: encodeJwt(accountId),
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    sseResponse('The current release is 24.1.0.', SOURCE_URL),
  );

  const result = await executeSearch(ctx);

  assert.equal(
    fetchSpy.mock.calls[0][0],
    'https://subscription-gateway.example.test/backend/codex/responses',
  );
  const init = fetchSpy.mock.calls[0][1] as RequestInit;
  const headers = new Headers(init.headers);
  assert.equal(headers.get('chatgpt-account-id'), accountId);
  assert.equal(headers.get('openai-beta'), 'responses=experimental');
  assert.equal(headers.get('originator'), 'pi');
  assert.match(headers.get('user-agent') ?? '', /cortex/i);
  const body = JSON.parse(String(init.body));
  assert.equal(body.model, 'search-model');
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.match(result.content[0].text, new RegExp(SOURCE_URL));
});

test('accepts Codex SSE when a proxy mislabels the response as JSON', async () => {
  const ctx = makeContext({
    api: 'openai-codex-responses',
    provider: 'codex-mislabeled-stream',
    apiKey: encodeJwt('acct-mislabeled-stream'),
  });
  const events = [
    ...successfulResponseEvents('Recovered streamed answer.', SOURCE_URL),
    { type: 'response.completed', response: { status: 'completed' } },
  ];
  const body = events.map((event) => (
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )).join('') + 'data: [DONE]\n\n';
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
    headers: { 'content-type': 'application/json' },
  }));

  const result = await executeSearch(ctx);

  const requestHeaders = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
  assert.equal(requestHeaders.get('accept'), 'text/event-stream');
  assert.match(result.content[0].text, /Recovered streamed answer/);
  assert.match(result.content[0].text, /Queries:\n- current stable runtime release/);
  assert.match(result.content[0].text, new RegExp(SOURCE_URL));
});

test('retries once without Anthropic domain fields when a 400 names them', async () => {
  const ctx = makeContext({
    api: 'anthropic-messages',
    provider: 'domain-filter-compatible',
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'allowed_domains is not supported' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      content: [
        { type: 'server_tool_use', input: { query: 'degraded domain query' } },
        { type: 'web_search_tool_result', content: [{ url: SOURCE_URL }] },
        { type: 'text', text: 'Search succeeded after dropping the wire field.' },
      ],
    }), { headers: { 'content-type': 'application/json' } }));

  const result = await executeSearch(ctx, {
    query: QUERY,
    allowed_domains: ['docs.example.test'],
    blocked_domains: ['archive.example.test'],
  });

  assert.equal(fetchSpy.mock.calls.length, 2);
  const firstBody = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
  const retryBody = JSON.parse(String((fetchSpy.mock.calls[1][1] as RequestInit).body));
  assert.deepEqual(firstBody.tools[0].allowed_domains, ['docs.example.test']);
  assert.equal(retryBody.tools[0].allowed_domains, undefined);
  assert.equal(retryBody.tools[0].blocked_domains, undefined);
  assert.match(retryBody.messages[0].content, /Only use these domains: docs\.example\.test/);
  assert.match(result.content[0].text, /Domain filtering was applied through the query prompt/i);
  assert.match(result.content[0].text, /Queries:\n- degraded domain query/);
});

test('negative-caches unknown search variants per provider:api', async () => {
  const firstCtx = makeContext({
    api: 'anthropic-messages',
    provider: 'negative-cache-provider-a',
  });
  const secondProviderCtx = makeContext({
    api: 'anthropic-messages',
    provider: 'negative-cache-provider-b',
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'tools.0.type: unknown variant' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      content: [
        { type: 'server_tool_use', input: { query: 'second provider query' } },
        { type: 'web_search_tool_result', content: [{ url: SOURCE_URL }] },
        { type: 'text', text: 'Search succeeded for the second provider.' },
      ],
    }), { headers: { 'content-type': 'application/json' } }));

  await assert.rejects(executeSearch(firstCtx), /websearch unavailable/i);
  await assert.rejects(executeSearch(firstCtx), /websearch unavailable/i);
  assert.equal(fetchSpy.mock.calls.length, 1, 'same provider:api should not probe twice');

  const result = await executeSearch(secondProviderCtx);
  assert.equal(fetchSpy.mock.calls.length, 2, 'different provider should probe independently');
  assert.match(result.content[0].text, new RegExp(SOURCE_URL));
});

test('does not negative-cache unrelated invalid_request errors', async () => {
  const ctx = makeContext({
    api: 'openai-responses',
    provider: 'non-capability-error-provider',
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({
      type: 'invalid_request_error',
      message: 'store must be omitted for this model',
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(sseResponse('Search succeeded on retry.', SOURCE_URL));

  await assert.rejects(executeSearch(ctx), /HTTP 400.*store must be omitted/i);
  const result = await executeSearch(ctx);

  assert.equal(fetchSpy.mock.calls.length, 2, 'non-capability errors must be probed again');
  assert.match(result.content[0].text, /Search succeeded on retry/);
});

test.each([
  [
    'response.failed',
    {
      type: 'response.failed',
      response: {
        status: 'failed',
        error: { code: 'server_error', message: 'search failed after partial output' },
      },
    },
    /server_error.*search failed after partial output/i,
  ],
  [
    'error',
    { type: 'error', code: 'stream_error', message: 'provider stream failed' },
    /stream_error.*provider stream failed/i,
  ],
])('rejects %s after valid-looking partial SSE output', async (_type, terminal, expected) => {
  const ctx = makeContext({
    api: 'openai-responses',
    provider: `failed-stream-provider-${_type}`,
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseEventsResponse([
    ...successfulResponseEvents('Partial answer.', SOURCE_URL),
    terminal as Record<string, unknown>,
  ]));

  await assert.rejects(executeSearch(ctx), expected as RegExp);
});

test('rejects Responses SSE output without a successful terminal event', async () => {
  const ctx = makeContext({
    api: 'openai-responses',
    provider: 'unterminated-stream-provider',
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseEventsResponse(
    successfulResponseEvents('Partial answer.', SOURCE_URL),
  ));

  await assert.rejects(executeSearch(ctx), /terminal response/i);
});

test('accepts a completed JSON Responses payload', async () => {
  const ctx = makeContext({
    api: 'openai-responses',
    provider: 'completed-json-provider',
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    JSON.stringify(jsonResponsesPayload('completed')),
    { headers: { 'content-type': 'application/json' } },
  ));

  const result = await executeSearch(ctx);

  assert.match(result.content[0].text, /current release is 24\.1\.0/i);
  assert.match(result.content[0].text, new RegExp(SOURCE_URL));
});

test.each([
  ['failed', { code: 'server_error', message: 'JSON search failed' }, /server_error.*JSON search failed/i],
  [undefined, undefined, /terminal status/i],
])('rejects a JSON Responses payload with status %s', async (status, error, expected) => {
  const ctx = makeContext({
    api: 'openai-responses',
    provider: `invalid-json-status-${status ?? 'missing'}`,
  });
  const payload = { ...jsonResponsesPayload(status), ...(error ? { error } : {}) };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    JSON.stringify(payload),
    { headers: { 'content-type': 'application/json' } },
  ));

  await assert.rejects(executeSearch(ctx), expected as RegExp);
});

test('unsupported APIs and auth failures return explicit errors without empty results', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  await assert.rejects(
    executeSearch(makeContext({ api: 'openai-completions', provider: 'unsupported-provider' })),
    /websearch unavailable.*search-model.*openai-completions/i,
  );
  await assert.rejects(
    executeSearch(makeContext({
      api: 'openai-responses',
      provider: 'missing-auth-provider',
      authError: 'credential expired',
    })),
    /credential expired/i,
  );
  assert.equal(fetchSpy.mock.calls.length, 0);
});

test('rejects successful provider responses that carry no executed query', async () => {
  const ctx = makeContext({
    api: 'anthropic-messages',
    provider: 'no-query-provider',
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    content: [
      { type: 'web_search_tool_result', content: [{ url: SOURCE_URL }] },
      { type: 'text', text: 'A sourced result without query provenance.' },
    ],
  }), { headers: { 'content-type': 'application/json' } }));

  await assert.rejects(executeSearch(ctx), /executed quer/i);
});

test('rejects successful provider responses that carry no source URL', async () => {
  const ctx = makeContext({
    api: 'anthropic-messages',
    provider: 'no-provenance-provider',
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    content: [{ type: 'text', text: 'A result without provenance.' }],
  }), { headers: { 'content-type': 'application/json' } }));

  await assert.rejects(executeSearch(ctx), /source url/i);
});
