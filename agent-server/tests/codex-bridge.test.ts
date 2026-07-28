// input:  Codex MCP config builder and section stripper
// output: backend privilege composition regression coverage
// pos:    Codex MCP sidecar configuration tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildMcpBlock } from '../src/domain/agents/index.js';
import { _test } from '../src/agent-adapter/codex/adapter.js';

test('buildMcpBlock points Codex routes to compiled dist/.js MCP sidecars without tsx loader', () => {
  const block = buildMcpBlock('C123', 'sess-1', 'dispatch', '/tmp/route-context.json');

  assert.match(block, /command = "node"/);
  assert.doesNotMatch(block, /"--import"/);
  assert.doesNotMatch(block, /loader\.mjs/);
  assert.doesNotMatch(block, /"tsx"/);
  assert.match(block, /dist\/domain\/mcp\/server\.js/);
  assert.match(block, /dist\/domain\/mcp\/core-server\.js/);
  assert.match(block, /dist\/domain\/mcp\/tasks-server\.js/);
  assert.match(block, /\[mcp_servers\.cortex-core\]/);
  assert.match(block, /\[mcp_servers\.cortex-tasks\]/);
  assert.match(block, /\[mcp_servers\.cortex-ext\]/);
  assert.doesNotMatch(block, /\[mcp_servers\.cortex-thread\]/);
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
  assert.match(block, /\[mcp_servers\.cortex-core\]/);
  assert.match(block, /\[mcp_servers\.cortex-tasks\]/);
  assert.match(block, /\[mcp_servers\.cortex-thread\]/);
  assert.doesNotMatch(block, /\[mcp_servers\.cortex-ext\]/);
});

test('buildMcpBlock — omitted context fields produce no CORTEX_THREAD_ID/PROFILE/PROJECT/SESSION_NAME lines', () => {
  const block = buildMcpBlock('C123', 'sess-1', null, '/tmp/route-context.json');
  assert.doesNotMatch(block, /CORTEX_THREAD_ID/);
  assert.doesNotMatch(block, /CORTEX_PROFILE/);
  assert.doesNotMatch(block, /CORTEX_PROJECT/);
  assert.doesNotMatch(block, /CORTEX_SESSION_NAME/);
});

test('thread config rewritten for a direct session leaves no stale thread server', () => {
  const threadBlock = buildMcpBlock('C123', 'sess-1', null, '/tmp/route-context.json', {
    threadId: 'thr_abc123',
  });
  const directBlock = buildMcpBlock('C123', 'sess-2', null, '/tmp/route-context.json');
  const base = ['model = "gpt-5"', threadBlock, '[features]', 'example = true'].join('\n');
  const rewritten = `${_test.stripCortexMcpSections(base)}\n${directBlock}`;

  assert.doesNotMatch(rewritten, /\[mcp_servers\.cortex-thread(?:\.env)?\]/);
  assert.equal(rewritten.match(/\[mcp_servers\.cortex-tasks\]/g)?.length, 1);
  assert.match(rewritten, /\[mcp_servers\.cortex-ext\]/);
  assert.match(rewritten, /\[features\]/);
});
