import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveCortexContext, toolContextFromEnv } from '../../../src/domain/mcp/tools/context.js';

const BOARD = { id: 'b1', title: 'Ship it', dir: '/ctx/boards/ship-it' };

test('context exposes the materialized selection and ignores legacy profile env', async () => {
  const ctx = toolContextFromEnv({
    CORTEX_PROFILE: 'obsolete', CORTEX_BACKEND: 'pi', CORTEX_MODEL: 'v4',
    CORTEX_PROVIDER: 'deepseek', CORTEX_THINKING: 'high', CORTEX_MODE: 'deepseek',
  });
  assert.deepEqual(ctx.selection, { backend: 'pi', provider: 'deepseek', model: 'v4', thinking: 'high', mode: 'deepseek' });
  const scope = await resolveCortexContext(ctx);
  assert.equal(scope.backend, 'pi');
  assert.equal(scope.model, 'v4');
  assert.equal(scope.thinking, 'high');
  assert.equal(scope.mode, 'deepseek');
  assert.equal(Object.hasOwn(scope, 'profile'), false);
  assert.equal(Object.hasOwn(ctx, 'profile'), false);
});

test('a web session reports its bound board, or null when it has none', async () => {
  const ctx = toolContextFromEnv({ CORTEX_SESSION_ID: 's1' });
  const asked: string[] = [];
  const bound = await resolveCortexContext(ctx, async (_c, id) => { asked.push(id); return BOARD; });
  assert.deepEqual(bound.board, BOARD);
  assert.deepEqual(asked, ['s1']);
  assert.equal((await resolveCortexContext(ctx, async () => null)).board, null);
});

test('a failed lookup leaves the board out instead of claiming there is none', async () => {
  const ctx = toolContextFromEnv({ CORTEX_SESSION_ID: 's1' });
  const scope = await resolveCortexContext(ctx, async () => { throw new Error('daemon down'); });
  assert.equal('board' in scope, false);
  assert.equal(scope.sessionId, 's1');
});

test('a session outside the Web UI is not asked about boards', async () => {
  const ctx = toolContextFromEnv({ SLACK_CHANNEL: 'C123' });
  let asked = false;
  const scope = await resolveCortexContext(ctx, async () => { asked = true; return BOARD; });
  assert.equal(asked, false);
  assert.equal('board' in scope, false);
});

test('the board field asked of the daemon carries exactly id, title and dir', async (t) => {
  const asked: any[] = [];
  // A daemon that still sends a field this release does not report.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      asked.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { ...BOARD, status: 'done', closedAt: 1 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;

  const scope = await resolveCortexContext(toolContextFromEnv({ CORTEX_SESSION_ID: 's1', WEBHOOK_PORT: String(port) }));
  assert.deepEqual(scope.board, BOARD);
  assert.deepEqual(Object.keys(scope.board!).sort(), ['dir', 'id', 'title']);
  assert.deepEqual(asked, [{ url: '/webhook/board', body: { sessionId: 's1', action: 'status' } }]);
});
