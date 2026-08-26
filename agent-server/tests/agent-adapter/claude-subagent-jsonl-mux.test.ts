// input:  Claude subagent JSONL mux, temp sidecars, mock tails
// output: realtime attribution, resume, parallel, and completion tests
// pos:    Claude TUI sidecar multiplexing regressions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ClaudeSubagentJsonlMux, type SubagentTailLike,
} from '../../src/agent-adapter/claude/subagent-jsonl-mux.js';

class MockTail extends EventEmitter implements SubagentTailLike {
  started = false;
  stopCalls = 0;
  flushCalls = 0;

  constructor(readonly path: string, readonly fromStart: boolean) { super(); }
  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> { this.stopCalls += 1; }
  flush(): void { this.flushCalls += 1; }
  push(raw: unknown): void { this.emit('event', raw); }
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-mux-'));
  const parent = path.join(root, 'session.jsonl');
  const sidecars = path.join(root, 'session', 'subagents');
  fs.writeFileSync(parent, '');
  const tails: MockTail[] = [];
  const events: any[] = [];
  const terminals: any[] = [];
  const mux = new ClaudeSubagentJsonlMux({
    parentJsonlPath: parent,
    pollIntervalMs: 5,
    settleMs: 10,
    tailFactory: (filePath, options) => {
      const tail = new MockTail(filePath, options?.fromStart === true);
      tails.push(tail);
      return tail;
    },
    onEvent: (event, source) => events.push({ event, source }),
    onTerminal: (terminal) => terminals.push(terminal),
  });
  return {
    root, sidecars, tails, events, terminals, mux,
    cleanup: async () => { await mux.stop(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function agentCall(id: string, prompt: string, description: string, type = 'explore') {
  return {
    type: 'assistant',
    message: { content: [{
      type: 'tool_use', id, name: 'Agent',
      input: { prompt, description, subagent_type: type },
    }] },
  };
}

function childPath(sidecars: string, agentId: string): string {
  fs.mkdirSync(sidecars, { recursive: true });
  const filePath = path.join(sidecars, `agent-${agentId}.jsonl`);
  fs.writeFileSync(filePath, `${JSON.stringify({
    type: 'user', isSidechain: true, agentId,
    message: { role: 'user', content: agentId === 'a' ? 'prompt-a' : 'prompt-b' },
  })}\n`);
  return filePath;
}

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('tails a new sidecar in real time and merges child facts with parent metadata', async () => {
  const h = harness();
  try {
    await h.mux.start();
    h.mux.observeParent(agentCall('parent-a', 'prompt-a', 'Inspect adapter'));
    const filePath = childPath(h.sidecars, 'a');
    await waitFor(() => h.tails.length === 1);
    assert.equal(h.tails[0].path, filePath);
    assert.equal(h.tails[0].fromStart, true);

    h.tails[0].push({
      type: 'assistant', isSidechain: true, agentId: 'a', attributionAgent: 'Explore',
      message: {
        id: 'child-message', model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id: 'child-tool', name: 'Read', input: { file_path: 'x' } }],
      },
    });

    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].event.type, 'tool_use');
    assert.deepEqual(h.events[0].event.subagent, {
      parentToolUseId: 'parent-a', type: 'Explore',
      description: 'Inspect adapter', model: 'claude-sonnet-5',
    });
    assert.deepEqual(h.events[0].source, { agentId: 'a', parentToolUseId: 'parent-a' });
  } finally { await h.cleanup(); }
});

test('correlates parallel sidecars by exact prompt even when files appear in reverse order', async () => {
  const h = harness();
  try {
    await h.mux.start();
    h.mux.observeParent(agentCall('parent-a', 'prompt-a', 'first'));
    h.mux.observeParent(agentCall('parent-b', 'prompt-b', 'second', 'reviewer'));
    const b = childPath(h.sidecars, 'b');
    const a = childPath(h.sidecars, 'a');
    await waitFor(() => h.tails.length === 2);

    const byPath = new Map(h.tails.map((tail) => [tail.path, tail]));
    byPath.get(b)!.push({
      type: 'assistant', isSidechain: true, agentId: 'b', attributionAgent: 'Reviewer',
      message: { id: 'b1', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'b' }] },
    });
    byPath.get(a)!.push({
      type: 'assistant', isSidechain: true, agentId: 'a', attributionAgent: 'Explore',
      message: { id: 'a1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'a' }] },
    });

    const refs = new Map(h.events.map(({ event }) => [event.text, event.subagent.parentToolUseId]));
    assert.deepEqual(refs, new Map([['b', 'parent-b'], ['a', 'parent-a']]));
  } finally { await h.cleanup(); }
});

test('uses first-level agentId and resolvedModel to supplement a child user envelope', async () => {
  const h = harness();
  try {
    await h.mux.start();
    h.mux.observeParent(agentCall('parent-a', 'prompt-a', 'Inspect adapter'));
    h.mux.observeParent({
      type: 'user', toolUseResult: {
        status: 'async_launched', agentId: 'a', description: 'Resolved description',
        resolvedModel: 'claude-opus-5[1m]',
      },
      message: { content: [{ type: 'tool_result', tool_use_id: 'parent-a', content: 'launched' }] },
    });
    childPath(h.sidecars, 'a');
    await waitFor(() => h.tails.length === 1);
    h.tails[0].push({
      type: 'user', isSidechain: true, agentId: 'a',
      message: { content: [{ type: 'tool_result', tool_use_id: 'child-tool', content: 'ok' }] },
    });

    assert.equal(h.mux.pendingBackgroundTasks, 1);
    assert.deepEqual(h.events[0].event.subagent, {
      parentToolUseId: 'parent-a', type: 'explore',
      description: 'Resolved description', model: 'claude-opus-5[1m]',
    });
  } finally { await h.cleanup(); }
});

test('ignores sidecars that already existed when a resumed mux started', async () => {
  const h = harness();
  try {
    childPath(h.sidecars, 'a');
    await h.mux.start();
    h.mux.observeParent(agentCall('parent-a', 'prompt-a', 'old'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.tails.length, 0);
  } finally { await h.cleanup(); }
});

test('deduplicates terminal notifications, flushes the sidecar, and clears pending count', async () => {
  const h = harness();
  try {
    await h.mux.start();
    h.mux.observeParent(agentCall('parent-a', 'prompt-a', 'Inspect adapter'));
    h.mux.observeParent({
      type: 'user', toolUseResult: { status: 'async_launched', agentId: 'a' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'parent-a', content: 'launched' }] },
    });
    childPath(h.sidecars, 'a');
    await waitFor(() => h.tails.length === 1);

    const notification = '<task-notification><task-id>a</task-id><tool-use-id>parent-a</tool-use-id>'
      + '<status>completed</status></task-notification>';
    h.mux.observeParent({ type: 'queue-operation', content: notification });
    h.mux.observeParent({ type: 'user', origin: { kind: 'task-notification' }, message: { content: notification } });
    await waitFor(() => h.terminals.length === 1);

    assert.equal(h.mux.pendingBackgroundTasks, 0);
    assert.equal(h.tails[0].flushCalls, 1);
    assert.equal(h.tails[0].stopCalls, 1);
    assert.deepEqual(h.terminals[0], {
      agentId: 'a', parentToolUseId: 'parent-a', pendingBackgroundTasks: 0,
    });
  } finally { await h.cleanup(); }
});
