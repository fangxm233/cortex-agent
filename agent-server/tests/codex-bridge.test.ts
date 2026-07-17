// input:  Node test runner + codex-bridge module
// output: Codex MCP config generation regression tests
// pos:    Verify compiled MCP sidecar path and plain-node invocation (no tsx loader)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildMcpBlock } from '../src/domain/agents/index.js';

test('buildMcpBlock points Codex routes to compiled dist/.js MCP sidecars without tsx loader', () => {
  const block = buildMcpBlock('C123', 'sess-1', 'dispatch', '/tmp/route-context.json');

  assert.match(block, /command = "node"/);
  assert.doesNotMatch(block, /"--import"/);
  assert.doesNotMatch(block, /loader\.mjs/);
  assert.doesNotMatch(block, /"tsx"/);
  assert.match(block, /dist\/domain\/mcp\/server\.js/);
  assert.match(block, /dist\/domain\/mcp\/core-server\.js/);
});

test('buildMcpBlock — context fields surface as CORTEX_THREAD_ID/PROFILE/PROJECT/SESSION_NAME env lines', () => {
  const block = buildMcpBlock('C123', 'sess-1', null, '/tmp/route-context.json', {
    threadId: 'thr_abc123',
    profile: 'fast-worker',
    project: 'cortex-self',
    sessionName: 'cortex-aaa111',
  });
  assert.match(block, /CORTEX_THREAD_ID = "thr_abc123"/);
  assert.match(block, /CORTEX_PROFILE = "fast-worker"/);
  assert.match(block, /CORTEX_PROJECT = "cortex-self"/);
  assert.match(block, /CORTEX_SESSION_NAME = "cortex-aaa111"/);
});

test('buildMcpBlock — omitted context fields produce no CORTEX_THREAD_ID/PROFILE/PROJECT/SESSION_NAME lines', () => {
  const block = buildMcpBlock('C123', 'sess-1', null, '/tmp/route-context.json');
  assert.doesNotMatch(block, /CORTEX_THREAD_ID/);
  assert.doesNotMatch(block, /CORTEX_PROFILE/);
  assert.doesNotMatch(block, /CORTEX_PROJECT/);
  assert.doesNotMatch(block, /CORTEX_SESSION_NAME/);
});
