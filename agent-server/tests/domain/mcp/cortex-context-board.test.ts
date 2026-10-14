import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveCortexContext, toolContextFromEnv } from '../../../src/domain/mcp/tools/context.js';

const BOARD = { id: 'b1', title: 'Ship it', status: 'active' as const, dir: '/ctx/boards/ship-it' };

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
