import '../_test-home.js'; // MUST be first import: isolate CORTEX_HOME before paths.ts loads
import { describe, test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createUiHttpServer } from '@platform/ui-http/ui-http-server.js';
import { createAppRouter } from '@domain/ui-service/app-router.js';
import { UI_SSE_KEEPALIVE } from '@domain/ui-service/trpc.js';
import type { UiService, SubscribeFilter, UiEvent } from '@domain/ui-service/types.js';

// The app's whole live state rides ONE SSE subscription. With tRPC's defaults (ping off, no client
// options) that stream sends nothing at all between events, so a socket silently dropped by a
// proxy, a NAT or a sleeping phone looks exactly like a quiet one — the client waits forever and
// every live surface freezes with no refetch (observed on mobile 2026-09-14). These tests hold the
// two halves of the keepalive that prevent it: the server pings, and it tells the client how long a
// silence may last (delivered in the `connected` event, so deployed clients get it without a
// rebuild).

const TOKEN = 'test-sse-keepalive-token';

const uiService: UiService = {
  async query() { return { ok: true, data: {} } as any; },
  async mutate() { return { ok: true, data: undefined } as any; },
  subscribe(_filter: SubscribeFilter) {
    // Deliberately silent: the point is what an IDLE stream puts on the wire.
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<UiEvent> {
        await new Promise<void>(() => {});
      },
      close() {},
    };
  },
} as unknown as UiService;

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => { for (const s of servers) await s.close().catch(() => {}); });

/** Read the SSE prologue (up to the first blank-line-terminated events) and hand back the raw text. */
function sseHead(port: number, urlPath: string, untilBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = http.get(
      { host: '127.0.0.1', port, path: urlPath, headers: { 'x-cortex-token': TOKEN, Accept: 'text/event-stream' } },
      (res) => {
        assert.equal(res.statusCode, 200);
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.length >= untilBytes) { r.destroy(); resolve(buf); }
        });
        res.on('error', () => { /* destroyed by us */ });
      },
    );
    r.on('error', (e) => { if (!String(e).includes('aborted')) reject(e); });
    setTimeout(() => { r.destroy(); resolve(''); }, timeoutMs).unref();
  });
}

describe('live SSE keepalive', () => {
  let port = 0;
  beforeAll(async () => {
    const inst = createUiHttpServer({
      router: createAppRouter(uiService),
      getToken: () => TOKEN,
      port: 0,
      host: '127.0.0.1',
      portForward: false,
    });
    servers.push(inst);
    await new Promise<void>((resolve, reject) => {
      if (inst.server.listening) return resolve();
      inst.server.once('listening', () => resolve());
      inst.server.once('error', reject);
    });
    const addr = inst.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no TCP address');
    port = addr.port;
  });

  test('the connected handshake carries the client inactivity window', async () => {
    const input = encodeURIComponent(JSON.stringify({ events: ['session.status'] }));
    const head = await sseHead(port, `/trpc/subscribe?input=${input}`, 24, 4000);

    // `event: connected` + `data: {...}`; the data object is what the client reads its
    // reconnect-after-inactivity timer from. An empty `{}` here is the bug this guards.
    const data = /event: connected\ndata: (.*)\n/.exec(head)?.[1];
    assert.ok(data, `no connected event in SSE prologue: ${JSON.stringify(head)}`);
    assert.deepEqual(
      JSON.parse(data!),
      { reconnectAfterInactivityMs: UI_SSE_KEEPALIVE.client.reconnectAfterInactivityMs },
    );
  });

  test('pings are enabled and fit inside the client inactivity window', () => {
    // tRPC itself rejects a ping slower than the client's window at request time; asserting it here
    // fails the build instead of the first subscription, and pins the intent: a client must see
    // several pings before it gives up on a silent stream.
    assert.equal(UI_SSE_KEEPALIVE.ping.enabled, true);
    assert.ok(UI_SSE_KEEPALIVE.ping.intervalMs > 0);
    assert.ok(
      UI_SSE_KEEPALIVE.ping.intervalMs * 2 <= UI_SSE_KEEPALIVE.client.reconnectAfterInactivityMs,
      'the inactivity window must tolerate at least two missed pings',
    );
  });
});
