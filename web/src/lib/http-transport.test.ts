import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@cortex-agent/ui-contract';
import { httpTransportFetch, HttpTransportError, findHttpTransportError } from './http-transport';
import { createTrpcClient } from './trpc';

const remote = { serverUrl: 'https://cortex.example', token: 'test-token' };
const url = `${remote.serverUrl}/trpc/sessions.send`;
const success = [{ result: { data: { accepted: true, acceptedAt: '2026-01-01T00:00:00Z' } } }];
const fallback = {
  connection: 'Unable to connect to Cortex right now. Please try again later.',
  authentication: 'Authentication failed. Please check your login status or connection credentials.',
  access: 'Access denied. Please check your permissions.',
  unexpected: 'Unexpected server response. Please try again later.',
};

function mockResponse(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function send() {
  return createTrpcClient(remote).sessions.send.mutate({ sessionId: 's1', text: 'hello' });
}

async function rejectedSend(): Promise<TRPCClientError<AppRouter>> {
  const error = await send().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(TRPCClientError);
  return error as TRPCClientError<AppRouter>;
}

afterEach(() => vi.unstubAllGlobals());

describe('HTTP transport through the real tRPC batch link', () => {
  it.each([
    [401, 'text/plain', 'authentication'],
    [401, 'text/html', 'authentication'],
    [403, 'text/plain', 'access'],
    [403, 'text/html', 'access'],
    [502, 'text/html', 'connection'],
    [503, 'text/plain', 'connection'],
    [504, 'text/html', 'connection'],
    [200, 'text/html', 'unexpected'],
    [500, 'text/plain', 'unexpected'],
  ] as const)('classifies %s %s without exposing the body or retrying', async (status, contentType, kind) => {
    const response = new Response('<html>private proxy page</html>', { status, headers: { 'Content-Type': contentType } });
    const fetch = mockResponse(response);
    const error = await rejectedSend();
    expect(error.cause).toBeInstanceOf(HttpTransportError);
    expect(findHttpTransportError(error)).toMatchObject({ kind, status, message: fallback[kind] });
    expect(error.message).toBe(fallback[kind]);
    expect(response.bodyUsed).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('wraps fetch network failures and retains their cause without retrying', async () => {
    const cause = new TypeError('Failed to fetch');
    const fetch = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal('fetch', fetch);
    const error = await rejectedSend();
    expect(findHttpTransportError(error)).toMatchObject({ kind: 'connection', cause, message: fallback.connection });
    expect(findHttpTransportError(error)?.status).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('preserves JSON success, remote URL, token and cancellation signal', async () => {
    const fetch = mockResponse(Response.json(success));
    await expect(send()).resolves.toEqual(success[0].result.data);
    const [input, init] = fetch.mock.calls[0];
    expect(String(input)).toBe(`${url}?batch=1`);
    expect(new Headers(init?.headers).get('x-cortex-token')).toBe(remote.token);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 502])('preserves business JSON errors even at HTTP %s', async (status) => {
    mockResponse(Response.json([{ error: {
      message: 'Business rule: cannot send now', code: -32600,
      data: { code: 'BAD_REQUEST', httpStatus: status, path: 'sessions.send' },
    } }], { status }));
    const error = await rejectedSend();
    expect(error.message).toBe('Business rule: cannot send now');
    expect(error.data).toMatchObject({ code: 'BAD_REQUEST', httpStatus: status });
    expect(findHttpTransportError(error)).toBeNull();
  });

  it('aborts an in-flight request when the real client caller cancels', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      started();
    }));
    vi.stubGlobal('fetch', fetch);
    const result = createTrpcClient(remote).sessions.send.mutate(
      { sessionId: 's1', text: 'hello' }, { signal: controller.signal },
    ).catch((error: unknown) => error);
    await ready;
    controller.abort();
    const error = await result;
    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error).toHaveProperty('cause.name', 'AbortError');
    expect(findHttpTransportError(error)).toBeNull();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps browser batches same-origin without adding authentication headers', async () => {
    const fetch = mockResponse(Response.json(success));
    await createTrpcClient().sessions.send.mutate({ sessionId: 's1', text: 'hello' });
    expect(fetch.mock.calls[0][0]).toBe('/trpc/sessions.send?batch=1');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('x-cortex-token')).toBe(false);
  });

  it('preserves AbortError through the tRPC cause chain', async () => {
    const abort = new DOMException('Cancelled', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    const error = await rejectedSend();
    expect(error.cause).toBe(abort);
    expect(findHttpTransportError(error)).toBeNull();
  });
});

describe('HTTP transport response and credential safety', () => {
  it.each(['application/json', 'Application/JSON; charset=utf-8', 'application/problem+json', null])(
    'leaves %s responses untouched and unread', async (contentType) => {
      const response = new Response(JSON.stringify(success));
      if (contentType) response.headers.set('Content-Type', contentType);
      else response.headers.delete('Content-Type');
      mockResponse(response);
      expect(await httpTransportFetch()(url)).toBe(response);
      expect(response.bodyUsed).toBe(false);
    },
  );

  it('does not reclassify malformed JSON as a network failure', async () => {
    mockResponse(new Response('not JSON', { headers: { 'Content-Type': 'application/json' } }));
    const error = await rejectedSend();
    expect(findHttpTransportError(error)).toBeNull();
  });

  it('preserves request options and abort identity', async () => {
    const controller = new AbortController();
    const abort = new DOMException('Cancelled', 'AbortError');
    const fetch = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal('fetch', fetch);
    const init = { method: 'POST', body: 'hello', signal: controller.signal, headers: { 'x-cortex-token': 'token' } };
    await expect(httpTransportFetch()(url, init)).rejects.toBe(abort);
    expect(fetch).toHaveBeenCalledWith(url, init);
  });

  it('preserves an aborted signal with a custom rejection reason', async () => {
    const controller = new AbortController();
    const reason = new TypeError('custom cancellation');
    controller.abort(reason);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(reason));
    await expect(httpTransportFetch()(url, { signal: controller.signal })).rejects.toBe(reason);
  });

  it('preserves credential guard errors and does not call fetch', async () => {
    const fetch = mockResponse(Response.json(success));
    const unsafe = 'http://remote.example/trpc/config.setPlatform';
    const error = await httpTransportFetch(remote.serverUrl)(unsafe).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('message', 'Platform credentials require HTTPS or loopback');
    expect(findHttpTransportError(error)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the credential guard through a real batched mutation', async () => {
    const fetch = mockResponse(Response.json(success));
    const client = createTrpcClient({ ...remote, serverUrl: 'http://remote.example' });
    const error = await client.config.setPlatform.mutate({ platform: 'slack', fields: {} })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error).toHaveProperty('message', 'Platform credentials require HTTPS or loopback');
    expect(findHttpTransportError(error)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains the sensitive-request redirect guard', async () => {
    const fetch = mockResponse(Response.json(success));
    const sensitiveUrl = `${remote.serverUrl}/trpc/config.setPlatform`;
    await httpTransportFetch(remote.serverUrl)(sensitiveUrl, { method: 'POST', redirect: 'follow' });
    expect(fetch).toHaveBeenCalledWith(sensitiveUrl, { method: 'POST', redirect: 'error' });
  });

  it('preserves non-network errors rather than matching their text', async () => {
    const cause = new Error('Failed to fetch / 401 / <html>');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
    await expect(httpTransportFetch()(url)).rejects.toBe(cause);
    expect(findHttpTransportError(cause)).toBeNull();
  });

  it('finds typed nested causes and safely ignores cyclic or untyped errors', () => {
    const typed = new HttpTransportError('connection', { status: 502 });
    expect(findHttpTransportError(new Error('wrapper', { cause: new Error('inner', { cause: typed }) }))).toBe(typed);
    const cyclic = new Error('cycle');
    cyclic.cause = cyclic;
    expect(findHttpTransportError(cyclic)).toBeNull();
    expect(findHttpTransportError({ kind: 'connection' })).toBeNull();
  });
});
