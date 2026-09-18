import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { MockAdapter } from '../src/platform/testing.js';
import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import { createUpdatePrompt } from '../src/orchestration/interactions/update-prompt.js';

/** Flush microtask queue so async `ask()` can set up internal pending state. */
const flush = () => setImmediate();

// ============================================================
// Button click paths
// ============================================================

test('Apply button click resolves ask() with "apply" and confirms', async () => {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' } as any);
  const router = new CommandActionRouter();
  const prompt = createUpdatePrompt(adapter, router);
  router.bindToAdapter(adapter);

  const askPromise = prompt.ask({ latestVersion: '2026.5.30' });
  await flush();

  await adapter.simulateAction('cmd:update:apply', '2026.5.30', {
    channelId: 'C-admin',
    messageRef: { conduit: 'C-admin', messageId: 'msg-apply' },
  });

  const result = await askPromise;
  assert.equal(result, 'apply');

  const lastUpdate = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdate, 'expected an updateMessage call');
});

// ============================================================
// Stale click (no pending prompt)
// ============================================================

test('stale button click without pending promise is no-op', async () => {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' } as any);
  const router = new CommandActionRouter();
  createUpdatePrompt(adapter, router);
  router.bindToAdapter(adapter);

  assert.equal(adapter.updated.length, 0);

  // Click without any pending ask() — should not throw
  await adapter.simulateAction('cmd:update:apply', '2026.5.30', {
    channelId: 'C-admin',
    messageRef: { conduit: 'C-admin', messageId: 'stale-msg' },
  });

  // No message should have been updated
  assert.equal(adapter.updated.length, 0);
});

// ============================================================
// Re-prompt: second ask() resolves first promise with null
// ============================================================

test('re-prompt while pending resolves old promise with null', async () => {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' } as any);
  const router = new CommandActionRouter();
  const prompt = createUpdatePrompt(adapter, router);
  router.bindToAdapter(adapter);

  const firstAsk = prompt.ask({ latestVersion: '2026.5.30' });
  await flush();
  const secondAsk = prompt.ask({ latestVersion: '2026.5.31' });
  await flush();

  // First promise should resolve null (superseded)
  const firstResult = await firstAsk;
  assert.equal(firstResult, null);

  // Second promise should still be pending — resolve it with a button click
  await adapter.simulateAction('cmd:update:apply', '2026.5.31', {
    channelId: 'C-admin',
    messageRef: { conduit: 'C-admin', messageId: 'msg-reprompt' },
  });

  const secondResult = await secondAsk;
  assert.equal(secondResult, 'apply');

});

// ============================================================
// Timeout
// ============================================================

test('timeout resolves ask() with null and edits message', async (t) => {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' } as any);
  const router = new CommandActionRouter();
  const prompt = createUpdatePrompt(adapter, router, { timeoutMs: 50 });
  router.bindToAdapter(adapter);

  const askPromise = prompt.ask({ latestVersion: '2026.5.30' });
  await flush();

  // Keep event loop alive long enough for the .unref()'d 50ms timeout to fire
  await new Promise(resolve => setTimeout(resolve, 150));

  const result = await askPromise;
  assert.equal(result, null);

  const lastUpdate = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdate, 'expected an updateMessage call');
});
