import { test } from 'vitest';
import assert from 'node:assert/strict';
import { triggerServerRestart } from '../src/orchestration/routing/commands/restart.js';
import { registerCommands } from '../src/orchestration/routing/commands/index.js';
import { MockAdapter } from '../src/platform/testing.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('triggerServerRestart: touches .restart when the daemon is alive', () => {
  let touched = 0;
  const out = triggerServerRestart({ livePid: () => 4242, touch: () => { touched++; } });
  assert.equal(out.ok, true);
  assert.equal(out.messageKey, 'triggered');
  assert.equal(touched, 1);
});

test('triggerServerRestart: no-op when no daemon is alive', () => {
  const touched: string[] = [];
  const out = triggerServerRestart({ livePid: () => null, touch: () => { touched.push('x'); } });
  assert.equal(out.ok, false);
  assert.equal(out.messageKey, 'noDaemon');
  assert.deepEqual(touched, [], 'must not touch .restart when there is no daemon to act on it');
});

test('!restart is routed to a handler and posts a reply', async () => {
  const dispatch = registerCommands({ scheduler: null });
  const adapter = new MockAdapter();
  const handled = dispatch('!restart', 'tui:test', adapter as any);
  assert.equal(handled, true, '!restart must be recognized as a command');
  await delay(50); // handler fires asynchronously via catchHandlerError
  assert.ok(adapter.posted.length >= 1, 'restart command posts a confirmation/notice');
});
