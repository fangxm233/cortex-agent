// input:  Installed tRPC server, ephemeral loopback HTTP server
// output: Genuine tRPC SSE and query test resources
// pos:    Reproducible native framing fixture capture
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { initTRPC } from '@trpc/server';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { writeFile } from 'node:fs/promises';

const t = initTRPC.create();
const session = { sessionId: 'session-one', projectId: 'project-one', origin: 'direct', running: true, awaitingInput: false };
const router = t.router({
  sessions: t.router({ list: t.procedure.input((value) => value).query(() => [session]) }),
  subscribe: t.procedure.input((value) => value).subscription(async function* () {
    yield { type: 'session.status', ts: '2026-01-01T00:00:00.000Z', payload: { sessionId: session.sessionId, running: true } };
    yield { type: 'session.interaction', ts: '2026-01-01T00:00:01.000Z', payload: { sessionId: session.sessionId, kind: 'ask-user', status: 'pending' } };
  }),
});
const server = createHTTPServer({ router });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const sse = await fetch(`${base}/subscribe?input=${encodeURIComponent(JSON.stringify({ events: ['session.status', 'session.interaction'] }))}`);
  const query = await fetch(`${base}/sessions.list?input=${encodeURIComponent(JSON.stringify({ origin: 'direct' }))}`);
  if (!sse.ok || !query.ok) throw new Error('Fixture requests failed');
  const root = new URL('../src/test/resources/', import.meta.url);
  await writeFile(new URL('trpc-subscribe.sse', root), await sse.text());
  await writeFile(new URL('trpc-sessions.json', root), `${await query.text()}\n`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
