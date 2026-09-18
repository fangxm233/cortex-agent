import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CompositeAdapter } from '../src/platform/adapters/composite-adapter.js';
import { MockAdapter } from '../src/platform/testing.js';

// ── No-op fallback for unowned conduits ───────────────────────────

test('CompositeAdapter.postMessage with unowned conduit returns valid MessageRef (not throw)', async () => {
  const mock = new MockAdapter();
  // Default ownsConduitFn returns true for everything except tui- — so mock owns all non-TUI.
  // To simulate a web session, make the mock NOT own web: conduits.
  mock.ownsConduitFn = (c) => !c.startsWith('web:');
  const comp = new CompositeAdapter([mock]);

  // The composite adapter should not throw when posting to an unowned conduit.
  // Instead, the internal no-op adapter should return a dummy MessageRef.
  const ref = await comp.postMessage(
    { type: 'interactive-reply', conduit: 'web:test-uuid-1234', sessionId: 'sess-1' },
    { text: 'Hello web' },
  );

  assert.ok(ref.messageId, 'should have a messageId');
  assert.ok(ref.messageId.startsWith('noop_'), 'should be a noop messageId');
  assert.equal(ref.conduit, 'web:test-uuid-1234');
  // The real mock adapter should NOT have recorded this post.
  assert.equal(mock.posted.length, 0, 'real adapter should not receive the post');
});

test('CompositeAdapter.ownsConduit: web conduits are not owned by any real adapter', () => {
  const mock = new MockAdapter();
  mock.ownsConduitFn = (c) => !c.startsWith('web:');
  const comp = new CompositeAdapter([mock]);

  assert.equal(comp.ownsConduit('web:test'), false);
  assert.equal(comp.ownsConduit('slack:C123'), true);
});

// ── Owned conduits still work normally ────────────────────────────

test('CompositeAdapter.postMessage with owned conduit routes to real adapter', async () => {
  const mock = new MockAdapter();
  // Default: mock owns non-TUI conduits
  const comp = new CompositeAdapter([mock]);

  const ref = await comp.postMessage(
    { type: 'interactive-reply', conduit: 'slack:C123', sessionId: 'sess-1' },
    { text: 'Hello Slack' },
  );

  assert.ok(ref.messageId);
  assert.equal(ref.conduit, 'slack:C123');
  assert.equal(mock.posted.length, 1, 'real adapter should receive the post');
  assert.equal(mock.posted[0].content.text, 'Hello Slack');
});
