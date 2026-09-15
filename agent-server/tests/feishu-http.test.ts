// input:  configureFeishuHttp driven against a fake axios-shaped instance
// output: the transport contract — timeout + keep-alive set once, uploads get the long timeout,
//         and the retry policy: pre-send failures retry on any method, post-send ones only on
//         idempotent methods, HTTP responses and stream bodies never
// pos:    tests — companion to src/platform/adapters/feishu-http.ts
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  configureFeishuHttp, isRetryableTransportError,
  DEFAULT_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS,
} from '../src/platform/adapters/feishu-http.js';

const TLS_MESSAGE = 'Client network socket disconnected before secure TLS connection was established';

interface Fake {
  defaults: Record<string, unknown>;
  interceptors: { request: { use: (ok: any) => void }; response: { use: (ok: any, fail: any) => void } };
  request: ReturnType<typeof vi.fn>;
  onRequest: ((config: any) => any) | null;
  onError: ((error: unknown) => Promise<unknown>) | null;
  uses: number;
}

/** An axios-shaped instance whose `request` re-enters the error interceptor the way axios does. */
function fakeInstance(requestImpl?: (config: any) => Promise<unknown>): Fake {
  const inst: Fake = {
    defaults: {},
    interceptors: {
      request: { use: (ok) => { inst.onRequest = ok; inst.uses += 1; } },
      response: { use: (_ok, fail) => { inst.onError = fail; inst.uses += 1; } },
    },
    request: vi.fn(),
    onRequest: null,
    onError: null,
    uses: 0,
  };
  inst.request.mockImplementation(requestImpl ?? (async (config: any) => ({ ok: true, config })));
  return inst;
}

function transportError(config: any, extra: Partial<{ code: string; message: string; response: unknown; request: unknown }> = {}) {
  return Object.assign(new Error(extra.message ?? 'socket hang up'), {
    isAxiosError: true, code: extra.code ?? 'ECONNRESET', config,
    ...(extra.response !== undefined ? { response: extra.response } : {}),
    ...(extra.request !== undefined ? { request: extra.request } : {}),
  });
}

function configure(inst: Fake, opts: Parameters<typeof configureFeishuHttp>[1] = {}) {
  const sleeps: number[] = [];
  configureFeishuHttp(inst as any, { sleep: async (ms) => { sleeps.push(ms); }, ...opts });
  return sleeps;
}

test('configures timeout + keep-alive agent once; a second call is a no-op', () => {
  const inst = fakeInstance();
  configure(inst);
  assert.equal(inst.defaults.timeout, DEFAULT_TIMEOUT_MS);
  assert.equal((inst.defaults.httpsAgent as any)?.keepAlive, true, 'explicit keep-alive agent');
  assert.equal(inst.uses, 2, 'one request + one response interceptor');
  configure(inst);
  assert.equal(inst.uses, 2, 'idempotent: no second pair of interceptors');
});

test('uploads and resource downloads get the long timeout; everything else keeps the default', () => {
  const inst = fakeInstance();
  configure(inst);
  const upload = inst.onRequest!({ url: 'https://open.feishu.cn/open-apis/im/v1/files', timeout: DEFAULT_TIMEOUT_MS });
  assert.equal(upload.timeout, DEFAULT_UPLOAD_TIMEOUT_MS);
  const download = inst.onRequest!({ url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/img_1?type=image', timeout: DEFAULT_TIMEOUT_MS });
  assert.equal(download.timeout, DEFAULT_UPLOAD_TIMEOUT_MS);
  const post = inst.onRequest!({ url: 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', timeout: DEFAULT_TIMEOUT_MS });
  assert.equal(post.timeout, DEFAULT_TIMEOUT_MS);
});

test('TLS handshake disconnect on a POST is retried and the retry result is returned', async () => {
  const inst = fakeInstance();
  const sleeps = configure(inst);
  const config = { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages' };
  const result = await inst.onError!(transportError(config, { message: TLS_MESSAGE }));
  assert.deepEqual(result, { ok: true, config: { ...config, __cortexFeishuRetry: 1 } });
  assert.equal(inst.request.mock.calls.length, 1);
  assert.deepEqual(sleeps, [250]);
});

test('retries are bounded: after the delays are used up the original error is rethrown', async () => {
  // `request` re-enters the error interceptor with the same config, as axios would.
  const inst = fakeInstance(async (config: any) => { throw transportError(config, { message: TLS_MESSAGE }); });
  inst.request.mockImplementation(async (config: any) => inst.onError!(transportError(config, { message: TLS_MESSAGE })));
  const sleeps = configure(inst);
  const config = { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages' };
  await assert.rejects(inst.onError!(transportError(config, { message: TLS_MESSAGE })), /before secure TLS/);
  assert.equal(inst.request.mock.calls.length, 2, 'two extra attempts, then give up');
  assert.deepEqual(sleeps, [250, 750]);
});

test('a plain ECONNRESET on a fresh socket is NOT retried for a POST (the request may have landed)', async () => {
  const inst = fakeInstance();
  configure(inst);
  const config = { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages' };
  await assert.rejects(inst.onError!(transportError(config, { request: { reusedSocket: false } })), /socket hang up/);
  assert.equal(inst.request.mock.calls.length, 0);
});

test('ECONNRESET on a reused keep-alive socket IS retried for a POST (Node’s documented safe case)', async () => {
  const inst = fakeInstance();
  configure(inst);
  const config = { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages' };
  await inst.onError!(transportError(config, { request: { reusedSocket: true } }));
  assert.equal(inst.request.mock.calls.length, 1);
});

test('a post-send transport error on an idempotent method (PATCH) is retried', async () => {
  const inst = fakeInstance();
  configure(inst);
  const config = { method: 'patch', url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_1' };
  await inst.onError!(transportError(config, { code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' }));
  assert.equal(inst.request.mock.calls.length, 1);
});

test('an HTTP response is never retried here, whatever the status', async () => {
  const inst = fakeInstance();
  configure(inst);
  const config = { method: 'get', url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_1' };
  await assert.rejects(inst.onError!(transportError(config, { code: 'ERR_BAD_RESPONSE', message: '503', response: { status: 503 } })), /503/);
  assert.equal(inst.request.mock.calls.length, 0);
});

test('a stream body (multipart upload) is never replayed', () => {
  const config = { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/files', data: { pipe() {}, getHeaders() {} } };
  assert.equal(isRetryableTransportError(transportError(config, { message: TLS_MESSAGE })), false);
});
