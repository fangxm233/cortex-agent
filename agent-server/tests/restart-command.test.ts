// input:  Node test runner + restart command
// output: triggerServerRestart pure-logic tests + !restart routing test
// pos:    Regression for the TUI/Slack `!restart` server-restart command
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { triggerServerRestart } from '../src/orchestration/routing/commands/restart.js';
import { registerCommands } from '../src/orchestration/routing/commands/index.js';
import { MockAdapter } from '../src/platform/testing.js';

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('triggerServerRestart: touches .restart when the daemon is alive', () => {
  const touched: string[] = [];
  const out = triggerServerRestart({
    storeDir: '/store',
    readPid: () => 4242,
    isAlive: (pid) => pid === 4242,
    touch: (f) => touched.push(f),
  });
  assert.equal(out.ok, true);
  assert.equal(out.messageKey, 'triggered');
  assert.deepEqual(touched, ['/store/.restart']);
});

test('triggerServerRestart: no-op when the daemon pid file is missing', () => {
  const touched: string[] = [];
  const out = triggerServerRestart({
    storeDir: '/store',
    readPid: () => null,
    isAlive: () => true,
    touch: (f) => touched.push(f),
  });
  assert.equal(out.ok, false);
  assert.equal(out.messageKey, 'noDaemon');
  assert.deepEqual(touched, [], 'must not touch .restart when there is no daemon to act on it');
});

test('triggerServerRestart: no-op when the daemon process is dead', () => {
  const touched: string[] = [];
  const out = triggerServerRestart({
    storeDir: '/store',
    readPid: () => 999,
    isAlive: () => false,
    touch: (f) => touched.push(f),
  });
  assert.equal(out.ok, false);
  assert.equal(out.messageKey, 'noDaemon');
  assert.deepEqual(touched, []);
});

test('!restart is routed to a handler and posts a reply', async () => {
  const dispatch = registerCommands({ scheduler: null });
  const adapter = new MockAdapter();
  const handled = dispatch('!restart', 'tui:test', adapter as any);
  assert.equal(handled, true, '!restart must be recognized as a command');
  await delay(50); // handler fires asynchronously via catchHandlerError
  assert.ok(adapter.posted.length >= 1, 'restart command posts a confirmation/notice');
});
