// input:  compiled MCP server entries and SDK stdio client
// output: deployed privilege surfaces and representative calls
// pos:    Built MCP server integration tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_DIST_DIR = resolve(TESTS_DIR, '../../../dist/domain/mcp');

function subprocessEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );
  env.CORTEX_THREAD_ID = '';
  return env;
}

async function withServer(
  fileName: string,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(MCP_DIST_DIR, fileName)],
    stderr: 'pipe',
    env: subprocessEnv(),
  });
  const client = new Client({ name: `test-${fileName}`, version: '1.0.0' });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await transport.close();
  }
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

test('built cortex-core exposes remote operations and current_time only', async () => {
  await withServer('core-server.js', async (client) => {
    assert.deepEqual(await toolNames(client), [
      'current_time',
      'remote_bash',
      'remote_edit',
      'remote_glob',
      'remote_grep',
      'remote_read',
      'remote_write',
    ]);
    const result = await client.callTool({ name: 'current_time', arguments: { timezone: 'UTC' } });
    assert.equal(result.isError ?? false, false);
    assert.equal(JSON.parse((result.content as any[])[0].text).timezone, 'UTC');
  });
});

test('built cortex-tasks exposes task monitoring and handles an empty project', async () => {
  await withServer('tasks-server.js', async (client) => {
    assert.deepEqual(await toolNames(client), ['task_list', 'task_result', 'task_status']);
    const result = await client.callTool({
      name: 'task_list',
      arguments: { project: 'stdio-empty-project' },
    });
    assert.equal(result.isError ?? false, false);
    assert.deepEqual(JSON.parse((result.content as any[])[0].text), { count: 0, tasks: [] });
  });
});

test('built cortex-thread exposes control tools and rejects calls outside a thread', async () => {
  await withServer('thread-server.js', async (client) => {
    assert.deepEqual(await toolNames(client), [
      'answer_subtask',
      'ask_manager',
      'thread_abort',
      'thread_split',
      'thread_wait',
    ]);
    const result = await client.callTool({
      name: 'thread_abort',
      arguments: { kind: 'mis-scoped', diagnosis: 'stdio boundary probe' },
    });
    assert.equal(result.isError, true);
    assert.match((result.content as any[])[0].text, /CORTEX_THREAD_ID unset/);
  });
});
