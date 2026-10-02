import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as http from 'node:http';
import { vi } from 'vitest';
import { createUiService } from '../src/domain/ui-service/ui-service.js';
import { createAppRouter } from '../src/domain/ui-service/app-router.js';
import { createUiHttpServer } from '../src/platform/ui-http/ui-http-server.js';
import type { UiServiceDeps } from '../src/domain/ui-service/types.js';

/** Real TCP, authenticated tRPC queries and SSE. Only the model/delivery are faked by the caller. */
export async function transcriptHttp(deps: UiServiceDeps, sessionId: string) {
  const host = createUiHttpServer({
    router: createAppRouter(createUiService(deps)), getToken: () => 'fixture-token',
    port: 0, host: '127.0.0.1', portForward: false,
  });
  if (!host.server.listening) await once(host.server, 'listening');
  const { port } = host.server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/trpc/`;
  const headers = { 'x-cortex-token': 'fixture-token' };
  const stream = await openSse(base, headers, sessionId);
  return {
    stream,
    async query(procedure: string, input: unknown) {
      const response = await fetch(`${base}${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers });
      assert.equal(response.status, 200);
      return (await response.json()).result.data;
    },
    async close() { stream.close(); await host.close(); },
  };
}

async function openSse(base: string, headers: Record<string, string>, sessionId: string) {
  let wire = '';
  const input = encodeURIComponent(JSON.stringify({
    sessionId, events: ['session.message', 'session.debug.updated'],
  }));
  const request = http.get(`${base}subscribe?input=${input}`, { headers }, response => {
    assert.equal(response.statusCode, 200);
    response.on('data', chunk => { wire += chunk; });
  });
  await vi.waitFor(() => assert.match(wire, /event: connected/));
  // The generator's subscription is installed after the connected prologue is emitted.
  await new Promise(resolve => setImmediate(resolve));
  return {
    get events(): any[] {
      return wire.split('\n\n').map(frame => frame.trim()).filter(frame => frame.startsWith('data: '))
        .map(frame => JSON.parse(frame.slice('data: '.length)));
    },
    get wire() { return wire; },
    close() { request.destroy(); },
  };
}
