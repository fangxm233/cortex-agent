// input:  Node test runner + codexEventToNormalized
// output: Codex JSON-RPC translator regression tests
// pos:    Lock down codex event-parser external contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { codexEventToNormalized } from '../src/agent-adapter/codex/event-parser.js';

test('item/completed with agentMessage maps to assistant_text', () => {
  const evt = codexEventToNormalized('item/completed', {
    item: { type: 'agentMessage', text: 'hello world' },
  });
  assert.deepEqual(evt, { type: 'assistant_text', text: 'hello world' });
});

test('item/completed with agentMessage trims whitespace and keeps empty strings as null', () => {
  const empty = codexEventToNormalized('item/completed', {
    item: { type: 'agentMessage', text: '   ' },
  });
  assert.equal(empty, null);

  const padded = codexEventToNormalized('item/completed', {
    item: { type: 'agentMessage', text: '  hi  ' },
  });
  assert.deepEqual(padded, { type: 'assistant_text', text: 'hi' });
});

test('item/completed with non-agentMessage item returns null (Phase 1 deferred)', () => {
  // commandExecution / fileChange tool-event mapping deferred to Phase 3 per DR-0008 §3.3
  const exec = codexEventToNormalized('item/completed', {
    item: { type: 'commandExecution', command: 'ls', exitCode: 0 },
  });
  assert.equal(exec, null);

  const file = codexEventToNormalized('item/completed', {
    item: { type: 'fileChange', path: '/tmp/x.txt' },
  });
  assert.equal(file, null);
});

test('account/rateLimits/updated maps to rate_limit with raw params', () => {
  const params = { rateLimits: { limitId: 'a', primary: { used: 0.5 } } };
  const evt = codexEventToNormalized('account/rateLimits/updated', params);
  assert.deepEqual(evt, { type: 'rate_limit', raw: params });
});

test('thread/error maps to error with non-fatal flag', () => {
  const evt = codexEventToNormalized('thread/error', { message: 'boom' });
  assert.deepEqual(evt, { type: 'error', message: 'boom', fatal: false });
});

test('thread/error with missing message falls back to a stable string', () => {
  const evt = codexEventToNormalized('thread/error', {});
  assert.deepEqual(evt, { type: 'error', message: 'codex thread error', fatal: false });
});

test('unknown method returns null', () => {
  assert.equal(codexEventToNormalized('turn/started', { turn: { id: 't1' } }), null);
  assert.equal(codexEventToNormalized('thread/tokenUsage/updated', { tokenUsage: { total: {} } }), null);
  assert.equal(codexEventToNormalized('codex/event/something', {}), null);
});

test('malformed or empty params do not throw', () => {
  // null params
  assert.doesNotThrow(() => codexEventToNormalized('item/completed', null as unknown as Record<string, unknown>));
  assert.equal(codexEventToNormalized('item/completed', null as unknown as Record<string, unknown>), null);
  // missing item
  assert.equal(codexEventToNormalized('item/completed', {}), null);
  // missing text on agentMessage
  assert.equal(
    codexEventToNormalized('item/completed', { item: { type: 'agentMessage' } }),
    null,
  );
});
