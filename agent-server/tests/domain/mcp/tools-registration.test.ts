// input:  MCP tool registries, mocked remote-command fetch
// output: Tool-name and compact mutation-response regressions
// pos:    MCP registration and remote mutation contract tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { registerTaskOpsTools } from '../../../src/domain/mcp/tools/task-ops.js';

test('ext-server (server.ts) registers 9 non-remote tool names (excluding platform-specific slack_send_file)', async () => {
  const mod = await import('../../../src/domain/mcp/server.js');
  const names: readonly string[] = mod.TOOL_NAMES;

  const expected = [
    'cost_query',
    'query_executions',
    'cortex_context',
    'cortex_schedule_add',
    'cortex_schedule_list',
    'cortex_schedule_get',
    'cortex_schedule_remove',
    'cortex_schedule_pause',
    'cortex_schedule_resume',
  ];

  assert.deepEqual([...names].sort(), [...expected].sort());
  assert.equal(names.length, 9);
  assert.equal(new Set(names).size, 9, 'no duplicate tool names');
});

test('slack-server (slack-server.ts) registers 1 platform-specific tool name', async () => {
  const mod = await import('../../../src/domain/mcp/slack-server.js');
  const names: readonly string[] = mod.TOOL_NAMES;

  const expected = ['slack_send_file'];

  assert.deepEqual([...names].sort(), [...expected].sort());
  assert.equal(names.length, 1);
  assert.equal(new Set(names).size, 1, 'no duplicate tool names');
});

test('web-server (web-server.ts) registers 1 Web-UI-specific tool name', async () => {
  const mod = await import('../../../src/domain/mcp/web-server.js');
  const names: readonly string[] = mod.TOOL_NAMES;

  const expected = ['send_file'];

  assert.deepEqual([...names].sort(), [...expected].sort());
  assert.equal(names.length, 1);
  assert.equal(new Set(names).size, 1, 'no duplicate tool names');
});

test('core-server (core-server.ts) registers 6 remote_* tools, current_time, 3 thread control tools, 3 task-monitor tools, and 2 manager-Q&A tools', async () => {
  const mod = await import('../../../src/domain/mcp/core-server.js');
  const names: readonly string[] = mod.TOOL_NAMES;

  const expected = [
    'remote_bash',
    'remote_read',
    'remote_write',
    'remote_edit',
    'remote_glob',
    'remote_grep',
    'current_time',
    // DR-0015 control plane tools (self-control of the caller's own thread) — retained
    'thread_abort',
    'thread_split',
    'thread_wait',
    // Task delegation is now the single agent-facing primitive: spawning via cortex-task,
    // monitoring via these read-only task tools (thread_start + 5 monitoring tools removed).
    'task_status',
    'task_result',
    'task_list',
    // DR-0016 up-ask channel: a subtask asks its manager (or a human); the manager answers.
    'ask_manager',
    'answer_subtask',
  ];

  assert.deepEqual([...names].sort(), [...expected].sort());
  assert.equal(names.length, 15);
  assert.equal(new Set(names).size, 15, 'no duplicate tool names');
});

function captureRemoteMutationHandlers(): Map<string, (...args: any[]) => Promise<any>> {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const fakeServer = {
    tool: (...args: any[]) => handlers.set(args[0], args.at(-1)),
  };
  registerTaskOpsTools(fakeServer as any);
  return handlers;
}

test('remote_write and remote_edit return compact confirmations without file snapshots', async () => {
  const canary = 'PRIVATE_FILE_CONTENT_CANARY';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    json: async () => ({
      success: true,
      data: {
        success: true,
        cortexMDs: [],
        originalFile: canary,
        newContent: `${canary}-after`,
      },
    }),
  } as Response);
  const handlers = captureRemoteMutationHandlers();

  const written = await handlers.get('remote_write')!(
    { device: 'lab', file_path: '/srv/x.md', content: 'after' },
    {},
  );
  const edited = await handlers.get('remote_edit')!(
    { device: 'lab', file_path: '/srv/x.md', old_string: 'before', new_string: 'after' },
    {},
  );

  assert.deepEqual(written, { content: [{ type: 'text', text: 'File written: /srv/x.md' }] });
  assert.deepEqual(edited, { content: [{ type: 'text', text: 'File edited: /srv/x.md' }] });
  assert.doesNotMatch(JSON.stringify([written, edited]), new RegExp(canary));
});
