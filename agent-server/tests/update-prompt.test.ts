// input:  Node test runner + createUpdatePrompt + MockAdapter + CommandActionRouter
// output: tests for update-prompt.ts — 4-button registration, click paths, stale, re-prompt, timeout
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { MockAdapter } from '../src/platform/testing.js';
import { CommandActionRouter } from '../src/orchestration/interactions/command-action-router.js';
import { createUpdatePrompt } from '../src/orchestration/interactions/update-prompt.js';

/** Flush microtask queue so async `ask()` can set up internal pending state. */
const flush = () => setImmediate();

// ============================================================
// Registration
// ============================================================

test('createUpdatePrompt registers four actionIds on router', () => {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' } as any);
  const router = new CommandActionRouter();
  createUpdatePrompt(adapter, router);
  router.bindToAdapter(adapter);

  // Each should not throw — handler is registered
  assert.doesNotThrow(async () => {
    await adapter.simulateAction('cmd:update:apply', '2026.5.30');
  });
  assert.doesNotThrow(async () => {
    await adapter.simulateAction('cmd:update:release-note', '2026.5.30');
  });
  assert.doesNotThrow(async () => {
    await adapter.simulateAction('cmd:update:skip', '2026.5.30');
  });
  assert.doesNotThrow(async () => {
    await adapter.simulateAction('cmd:update:cancel', '2026.5.30');
  });
});

// ============================================================
// ask() posts interactive message
// ============================================================

test('ask() posts interactive message to system-notice with four buttons', async () => {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' } as any);
  const router = new CommandActionRouter();
  const prompt = createUpdatePrompt(adapter, router);
  router.bindToAdapter(adapter);

  prompt.ask({ latestVersion: '2026.5.30' });

  const noticePost = adapter.posted.find(p => p.destination.type === 'system-notice');
  assert.ok(noticePost, 'expected a system-notice post');

  // Check actions array on the posted object
  const actions = noticePost.actions;
  assert.ok(actions, 'expected actions on posted message');
  assert.equal(actions.length, 4);

  // Verify button metadata
  const applyBtn = actions.find(a => a.actionId === 'cmd:update:apply');
  const releaseNoteBtn = actions.find(a => a.actionId === 'cmd:update:release-note');
  const skipBtn = actions.find(a => a.actionId === 'cmd:update:skip');
  const cancelBtn = actions.find(a => a.actionId === 'cmd:update:cancel');
  assert.ok(applyBtn);
  assert.ok(releaseNoteBtn);
  assert.ok(skipBtn);
  assert.ok(cancelBtn);

  assert.equal(applyBtn!.style, 'primary');
  assert.equal(releaseNoteBtn!.style, undefined);
  assert.equal(skipBtn!.style, undefined);
  assert.equal(cancelBtn!.style, 'danger');

  // Value carries latestVersion
  assert.equal(applyBtn!.value, '2026.5.30');
  assert.equal(releaseNoteBtn!.value, '2026.5.30');
  assert.equal(skipBtn!.value, '2026.5.30');
  assert.equal(cancelBtn!.value, '2026.5.30');
});

// Regression: postInteractive appends an actions block from content.actions
// (slack.ts:434-440) AND renders any actions block inside richBlocks
// (slack.ts:711-715, via richBlocksToSlack). If both are populated, the user
// sees two identical button rows in Slack. richBlocks must contain content
// blocks only — buttons belong in the top-level actions array.
// Pattern reference: buildPlanApprovalContent (interactive-builder.ts:117-127).
test('ask() does not embed an actions block inside richBlocks (avoid duplicate buttons)', () => {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' } as any);
  const router = new CommandActionRouter();
  const prompt = createUpdatePrompt(adapter, router);
  router.bindToAdapter(adapter);

  prompt.ask({ latestVersion: '2026.5.30' });

  const noticePost = adapter.posted.find(p => p.destination.type === 'system-notice');
  assert.ok(noticePost, 'expected a system-notice post');

  const richBlocks = noticePost.content.richBlocks ?? [];
  const embeddedActionsBlocks = richBlocks.filter((b: any) => b.type === 'actions');
  assert.equal(
    embeddedActionsBlocks.length,
    0,
    'richBlocks must not contain actions blocks — postInteractive auto-appends actions, so embedding here causes a duplicate button row',
  );
});

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
  assert.ok(lastUpdate.content.text.includes('Installing'), 'expected install confirmation');
  assert.ok(lastUpdate.content.text.includes('2026.5.30'), 'expected version in confirmation');
});

test('Skip button click resolves ask() with "skip" and confirms', async () => {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' } as any);
  const router = new CommandActionRouter();
  const prompt = createUpdatePrompt(adapter, router);
  router.bindToAdapter(adapter);

  const askPromise = prompt.ask({ latestVersion: '2026.5.30' });
  await flush();

  await adapter.simulateAction('cmd:update:skip', '2026.5.30', {
    channelId: 'C-admin',
    messageRef: { conduit: 'C-admin', messageId: 'msg-skip' },
  });

  const result = await askPromise;
  assert.equal(result, 'skip');

  const lastUpdate = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdate, 'expected an updateMessage call');
  assert.ok(lastUpdate.content.text.includes('Skipped'), 'expected skip confirmation');
  assert.ok(lastUpdate.content.text.includes('2026.5.30'), 'expected version in confirmation');
});

test('Cancel button click resolves ask() with "cancel" and confirms', async () => {
  const adapter = new MockAdapter({ adminChannel: 'C-admin' } as any);
  const router = new CommandActionRouter();
  const prompt = createUpdatePrompt(adapter, router);
  router.bindToAdapter(adapter);

  const askPromise = prompt.ask({ latestVersion: '2026.5.30' });
  await flush();

  await adapter.simulateAction('cmd:update:cancel', '2026.5.30', {
    channelId: 'C-admin',
    messageRef: { conduit: 'C-admin', messageId: 'msg-cancel' },
  });

  const result = await askPromise;
  assert.equal(result, 'cancel');

  const lastUpdate = adapter.updated[adapter.updated.length - 1];
  assert.ok(lastUpdate, 'expected an updateMessage call');
  assert.ok(lastUpdate.content.text.includes('cancelled'), 'expected cancel confirmation');
  assert.ok(lastUpdate.content.text.includes('next interval'), 'expected next-interval mention');
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

  // First message should have been edited to "superseded"
  const supersededUpdate = adapter.updated.find(u =>
    u.content.text.toLowerCase().includes('superseded'),
  );
  assert.ok(supersededUpdate, 'expected superseded edit on first message');

  // Second promise should still be pending — resolve it with a button click
  await adapter.simulateAction('cmd:update:apply', '2026.5.31', {
    channelId: 'C-admin',
    messageRef: { conduit: 'C-admin', messageId: 'msg-reprompt' },
  });

  const secondResult = await secondAsk;
  assert.equal(secondResult, 'apply');

  // Second message should have install confirmation
  const applyUpdate = adapter.updated.find(u =>
    u.content.text.includes('Installing') && u.content.text.includes('2026.5.31'),
  );
  assert.ok(applyUpdate, 'expected install confirmation for version 2026.5.31');
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
  assert.ok(lastUpdate.content.text.includes('timed out'), 'expected timed out message');
});
