// input:  Node test runner + registerMessageHandler + MockAdapter
// output: early-return branches + edit delegation tests
// pos:    Verify message-router core routing branches
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/platform/testing.js';
import { registerMessageHandler, type MessageHandlerDeps } from '../src/orchestration/routing/message-router.js';
import type { MessageEditContext } from '../src/platform/types.js';

interface DispatchCall {
  text: string | undefined;
  channel: string;
}

function buildDeps(dispatchReturns: boolean = false): {
  deps: MessageHandlerDeps;
  dispatchCalls: DispatchCall[];
  editCalls: MessageEditContext[];
} {
  const dispatchCalls: DispatchCall[] = [];
  const editCalls: MessageEditContext[] = [];
  const deps: MessageHandlerDeps = {
    dispatchCommand: (text, channel) => {
      dispatchCalls.push({ text, channel });
      return dispatchReturns;
    },
    handleMessageEdit: (ctx) => {
      editCalls.push(ctx);
    },
  };
  return { deps, dispatchCalls, editCalls };
}

test('registerMessageHandler wires both onMessage and onMessageEdit on the adapter', async () => {
  const adapter = new MockAdapter();
  const { deps, editCalls } = buildDeps();
  registerMessageHandler(adapter, deps);

  // onMessageEdit delegation: edit ctx is forwarded to deps.handleMessageEdit.
  await adapter.simulateMessageEdit('C1', 'M1', 'edited text');
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0].originalRef.conduit, 'C1');
  assert.equal(editCalls[0].newText, 'edited text');
});

test('plain bot message (no BRANCH_CALLBACK prefix) returns early without dispatching', async () => {
  const adapter = new MockAdapter();
  const { deps, dispatchCalls } = buildDeps();
  registerMessageHandler(adapter, deps);

  await adapter.simulateMessage('C1', 'hello from a bot', { isBot: true });
  assert.equal(dispatchCalls.length, 0);
  assert.equal(adapter.posted.length, 0);
});

test('[BRANCH_CALLBACK] bot message has prefix stripped and continues processing', async () => {
  const adapter = new MockAdapter();
  const { deps, dispatchCalls } = buildDeps(/* dispatchReturns */ true);
  registerMessageHandler(adapter, deps);

  // The BRANCH_CALLBACK prefix is stripped before shouldSkipForCommandDispatch runs, so
  // dispatchCommand receives the cleaned text and returns true → handler exits early.
  await adapter.simulateMessage('C1', '[BRANCH_CALLBACK]!status', { isBot: true });
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].text, '!status');
});

test('message with kind=system is skipped before dispatchCommand', async () => {
  const adapter = new MockAdapter();
  const { deps, dispatchCalls } = buildDeps();
  registerMessageHandler(adapter, deps);

  // Inject a system-kind message via raw message shape.
  const handlers = (adapter as any).messageHandlers as Array<(ctx: any) => Promise<void>>;
  await handlers[0]({
    message: {
      kind: 'system',
      isBot: false,
      text: 'ignored',
      files: [],
      ref: { conduit: 'C1', messageId: 'M1' },
    },
    reply: async () => {},
  });
  assert.equal(dispatchCalls.length, 0);
});

test('message with no text, no files, no forwarded content returns early', async () => {
  const adapter = new MockAdapter();
  const { deps, dispatchCalls } = buildDeps();
  registerMessageHandler(adapter, deps);

  await adapter.simulateMessage('C1', '', { isBot: false });
  assert.equal(dispatchCalls.length, 0);
  assert.equal(adapter.posted.length, 0);
});

test('non-thread command that dispatchCommand claims causes early return', async () => {
  const adapter = new MockAdapter();
  const { deps, dispatchCalls } = buildDeps(/* dispatchReturns */ true);
  registerMessageHandler(adapter, deps);

  await adapter.simulateMessage('C1', '!status', { senderId: 'U1' });
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].text, '!status');
  // Dispatch claimed it — no further postMessage should have been emitted by the router.
  assert.equal(adapter.posted.length, 0);
});

test('handleMessageEdit is NOT invoked on plain message events (short-circuited by dispatchCommand)', async () => {
  const adapter = new MockAdapter();
  // dispatchReturns=true so the regular-message path short-circuits before reaching runAgent.
  // This isolates the test from real LLM subprocess spawning.
  const { deps, editCalls } = buildDeps(/* dispatchReturns */ true);
  registerMessageHandler(adapter, deps);

  await adapter.simulateMessage('C1', '!status', { senderId: 'U1' });
  assert.equal(editCalls.length, 0);
});
