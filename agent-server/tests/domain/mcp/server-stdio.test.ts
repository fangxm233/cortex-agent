// input:  compiled MCP entries, tool gates, stdio client, QA webhook
// output: gated privilege surfaces, refusals and answerer identity
// pos:    Built MCP server integration tests
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MCP_TOOL_ALLOWLIST_ENV } from '../../../src/core/mcp-tool-gate.js';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_DIST_DIR = resolve(TESTS_DIR, '../../../dist/domain/mcp');

function subprocessEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );
  return { ...env, CORTEX_THREAD_ID: '', ...overrides };
}

async function withServer(
  fileName: string,
  run: (client: Client) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(MCP_DIST_DIR, fileName)],
    stderr: 'pipe',
    env: subprocessEnv(env),
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

async function withQaWebhook(
  run: (port: number, received: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const received: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { accepted: true } }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    await run((server.address() as AddressInfo).port, received);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
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

test('built cortex-thread exposes lifecycle control and upward ask only', async () => {
  await withServer('thread-server.js', async (client) => {
    assert.deepEqual(await toolNames(client), [
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

test('tool gate removes ask_manager without removing thread_wait or task monitoring', async () => {
  const gate = JSON.stringify(['task_status', 'thread_wait']);
  const env = { [MCP_TOOL_ALLOWLIST_ENV]: gate };
  await withServer('thread-server.js', async (client) => {
    assert.deepEqual(await toolNames(client), ['thread_wait']);
  }, env);
  await withServer('tasks-server.js', async (client) => {
    assert.deepEqual(await toolNames(client), ['task_status']);
  }, env);
});

test('a declared empty tool gate starts with zero registered tools', async () => {
  await withServer('thread-server.js', async (client) => {
    await client.ping();
    await assert.rejects(client.listTools(), /Method not found/);
  }, { [MCP_TOOL_ALLOWLIST_ENV]: '[]' });
});

test('an unknown tool gate name refuses MCP server startup', async () => {
  await assert.rejects(withServer('thread-server.js', async () => {}, {
    [MCP_TOOL_ALLOWLIST_ENV]: JSON.stringify(['thread_wait', 'thread_wiat']),
  }));
});

test('built cortex-manager-qa answers without a thread context', async () => {
  await withQaWebhook(async (port, received) => {
    await withServer('manager-qa-server.js', async (client) => {
      assert.deepEqual(await toolNames(client), ['answer_subtask']);
      const result = await client.callTool({
        name: 'answer_subtask',
        arguments: { question_id: 'q-direct', answer: 'Use approach A.' },
      });
      assert.equal(result.isError ?? false, false);
      assert.deepEqual(received, [{
        action: 'answer', question_id: 'q-direct', answer: 'Use approach A.',
        answererThreadId: null,
      }]);
    }, { WEBHOOK_PORT: String(port), CORTEX_WEBHOOK_TOKEN: 'stdio-token' });
  });
});

test('built cortex-web exposes file, view and decision delivery to a web session', async () => {
  await withQaWebhook(async (port, received) => {
    await withServer('web-server.js', async (client) => {
      assert.deepEqual(await toolNames(client), ['send_decision', 'send_file', 'send_view']);

      const result = await client.callTool({
        name: 'send_view',
        arguments: { title: 'Sweep results', html: '<h1>hi</h1>', caption: 'by seed', height: 420 },
      });
      assert.equal(result.isError ?? false, false);
      assert.deepEqual(received, [{
        sessionId: 'stdio-web-session', title: 'Sweep results',
        html: '<h1>hi</h1>', caption: 'by seed', height: 420,
      }]);
    }, {
      WEBHOOK_PORT: String(port),
      CORTEX_WEBHOOK_TOKEN: 'stdio-token',
      CORTEX_SESSION_ID: 'stdio-web-session',
    });
  });
});

test('send_decision proxies the decision batch to the daemon webhook', async () => {
  await withQaWebhook(async (port, received) => {
    await withServer('web-server.js', async (client) => {
      const decision = {
        title: 'Store results in SQLite',
        decision: 'Run outputs go into results.db instead of JSONL files.',
        context: 'Both stores were possible; queries were getting slow.',
        reasoning: 'Indexed queries stay fast as runs accumulate.',
      };
      const result = await client.callTool({ name: 'send_decision', arguments: { decisions: [decision] } });
      assert.equal(result.isError ?? false, false);
      assert.match((result.content as any[])[0].text, /Recorded 1 decision/);
      assert.deepEqual(received, [{ sessionId: 'stdio-web-session', decisions: [decision] }]);

      const empty = await client.callTool({ name: 'send_decision', arguments: { decisions: [] } });
      assert.equal(empty.isError, true, 'an empty batch is refused before it reaches the daemon');
      assert.equal(received.length, 1);
    }, {
      WEBHOOK_PORT: String(port),
      CORTEX_WEBHOOK_TOKEN: 'stdio-token',
      CORTEX_SESSION_ID: 'stdio-web-session',
    });
  });
});

test('send_view refuses ambiguous input before it reaches the daemon', async () => {
  await withQaWebhook(async (port, received) => {
    await withServer('web-server.js', async (client) => {
      for (const args of [
        { title: 'T' },
        { title: 'T', html: '<p/>', file_path: '/tmp/nope.html' },
      ]) {
        const result = await client.callTool({ name: 'send_view', arguments: args });
        assert.equal(result.isError, true);
        assert.match((result.content as any[])[0].text, /exactly one of/i);
      }
      assert.deepEqual(received, [], 'a malformed call never reaches the daemon');
    }, {
      WEBHOOK_PORT: String(port),
      CORTEX_WEBHOOK_TOKEN: 'stdio-token',
      CORTEX_SESSION_ID: 'stdio-web-session',
    });
  });
});

test('the tool gate can drop send_view while keeping send_file', async () => {
  await withServer('web-server.js', async (client) => {
    assert.deepEqual(await toolNames(client), ['send_file']);
  }, { [MCP_TOOL_ALLOWLIST_ENV]: JSON.stringify(['send_file']) });
});
