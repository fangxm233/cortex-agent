// input:  PI hook bridge, fixture hook registry, recorder scripts
// output: PI registry event mapping and data-driven dispatch tests
// pos:    Verifies PI hook registration follows declarative entries
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'vitest';

import hookBridge from '../src/agent-adapter/pi/hook-bridge.js';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '../src/agent-adapter/pi/pi-ext-types.js';
import { CONFIG_DIR, HOOKS_DIR } from '../src/core/paths.js';

type Handler = (event: any, ctx: ExtensionContext) => any;

class FakePi implements Pick<ExtensionAPI, 'on'> {
  readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  async emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const next = await handler(payload, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  }
}

function makeCtx(): ExtensionContext {
  return {
    signal: undefined,
    cwd: process.cwd(),
    ui: {
      select: async () => null,
      confirm: async () => null,
      input: async () => null,
      editor: async () => null,
      notify: () => {},
    },
    sessionManager: { getSessionFile: () => '/tmp/pi-registry-session.jsonl' },
  };
}

function writeEntry(directory: string, filename: string, entry: unknown): void {
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(entry, null, 2)}\n`);
}

function writeRecorder(filename: string, label: string): void {
  const source = [
    "import { appendFileSync } from 'node:fs';",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    `appendFileSync(process.env.PI_HOOK_TEST_LOG, JSON.stringify({ label: ${JSON.stringify(label)}, payload: JSON.parse(input) }) + '\\n');`,
  ].join('\n');
  fs.writeFileSync(path.join(HOOKS_DIR, filename), `${source}\n`);
}

function writeInputUpdater(): void {
  const source = [
    "import { appendFileSync } from 'node:fs';",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    "const payload = JSON.parse(input);",
    "appendFileSync(process.env.PI_HOOK_TEST_LOG, JSON.stringify({ label: 'update', payload }) + '\\n');",
    "process.stdout.write(JSON.stringify({ hookSpecificOutput: { updatedInput: { ...payload.tool_input, answer: 'updated' } } }));",
  ].join('\n');
  fs.writeFileSync(path.join(HOOKS_DIR, 'record-update.mjs'), `${source}\n`);
}

function readLabels(logFile: string): string[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { label: string }).label);
}

const LIFECYCLE_EVENTS = [
  ['04-session-start.json', 'agent:session-start', 'before_agent_start'],
  ['05-session-end.json', 'agent:session-end', 'session_shutdown'],
  ['06-pre-compact.json', 'agent:pre-compact', 'session_before_compact'],
  ['07-user-prompt.json', 'agent:user-prompt', 'input'],
  ['08-turn-end.json', 'agent:turn-end', 'turn_end'],
] as const;

interface Fixture {
  registryDir: string;
  logFile: string;
  ctx: ExtensionContext;
}

function setupFixture(t: { onTestFinished(callback: () => void): void }): Fixture {
  const registryDir = path.join(CONFIG_DIR, 'hooks');
  const logFile = path.join(CONFIG_DIR, 'pi-hook-registry.jsonl');
  const previousLog = process.env.PI_HOOK_TEST_LOG;
  process.env.PI_HOOK_TEST_LOG = logFile;
  fs.rmSync(registryDir, { recursive: true, force: true });
  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  t.onTestFinished(() => {
    if (previousLog === undefined) delete process.env.PI_HOOK_TEST_LOG;
    else process.env.PI_HOOK_TEST_LOG = previousLog;
  });
  return { registryDir, logFile, ctx: makeCtx() };
}

function writeRecorderScripts(): void {
  writeRecorder('record-alpha.mjs', 'alpha');
  writeRecorder('record-beta.mjs', 'beta');
  writeRecorder('record-native.mjs', 'native');
  writeRecorder('record-claude-only.mjs', 'claude-only');
  writeRecorder('record-web.mjs', 'web');
  writeRecorder('record-mcp.mjs', 'mcp');
  writeInputUpdater();
}

function writeBaseEntries(registryDir: string): void {
  writeEntry(registryDir, '01-alpha.json', {
    id: 'alpha', event: 'agent:post-tool', matcher: 'Read',
    run: { script: 'record-alpha.mjs' },
  });
  writeEntry(registryDir, '02-tasks-guard.json', {
    id: 'tasks-yaml-guard', event: 'agent:post-tool', matcher: 'Read',
    run: { script: 'record-claude-only.mjs' }, scope: { backends: ['claude'] },
  });
  writeEntry(registryDir, '03-native.json', {
    id: 'native', event: 'pi:custom_event', run: { script: 'record-native.mjs' },
  });
  writeEntry(registryDir, '03-update.json', {
    id: 'update', event: 'agent:pre-tool', matcher: 'AskUserQuestion',
    run: { script: 'record-update.mjs' },
  });
  writeEntry(registryDir, '03-web.json', {
    id: 'web', event: 'agent:post-tool', matcher: 'Web(Fetch|Search)',
    run: { script: 'record-web.mjs' },
  });
  writeEntry(registryDir, '03-mcp.json', {
    id: 'mcp', event: 'agent:post-tool', matcher: 'mcp__cortex__probe',
    run: { script: 'record-mcp.mjs' },
  });
}

function writeLifecycleEntries(registryDir: string): void {
  for (const [filename, event] of LIFECYCLE_EVENTS) {
    writeEntry(registryDir, filename, {
      id: filename.replace('.json', ''),
      event,
      run: { script: 'record-alpha.mjs' },
    });
  }
}

function makeBridge(): FakePi {
  const pi = new FakePi();
  hookBridge(pi as unknown as ExtensionAPI);
  return pi;
}

function assertRegistrations(pi: FakePi): void {
  assert.ok(pi.handlers.has('tool_call'));
  assert.ok(pi.handlers.has('tool_result'));
  assert.ok(pi.handlers.has('custom_event'));
  for (const [, , nativeEvent] of LIFECYCLE_EVENTS) {
    assert.ok(pi.handlers.has(nativeEvent), `expected handler for ${nativeEvent}`);
  }
}

function toolResult(toolName: string, toolCallId: string): Record<string, unknown> {
  return {
    toolName,
    toolCallId,
    input: { path: '/tmp/example.txt' },
    content: [],
    isError: false,
  };
}

async function verifyInitialDispatch(pi: FakePi, fixture: Fixture): Promise<void> {
  const input = { questions: [] };
  const call = { toolName: 'ask_user_question', toolCallId: 'ask-1', input };
  await pi.emit('tool_call', call, fixture.ctx);
  assert.equal(call.input, input);
  assert.equal((input as Record<string, unknown>).answer, 'updated');
  await pi.emit('tool_result', toolResult('read', 'read-1'), fixture.ctx);
  assert.deepEqual(readLabels(fixture.logFile), ['update', 'alpha']);
  await pi.emit('tool_result', toolResult('write', 'write-1'), fixture.ctx);
  await pi.emit('tool_result', toolResult('web_fetch', 'web-1'), fixture.ctx);
  await pi.emit('tool_result', toolResult('mcp__cortex__probe', 'mcp-1'), fixture.ctx);
  assert.deepEqual(readLabels(fixture.logFile), ['update', 'alpha', 'web', 'mcp']);
  await pi.emit('custom_event', { message: 'native payload' }, fixture.ctx);
  assert.deepEqual(readLabels(fixture.logFile), ['update', 'alpha', 'web', 'mcp', 'native']);
}

async function verifyAddedEntry(fixture: Fixture): Promise<void> {
  writeEntry(fixture.registryDir, '09-beta.json', {
    id: 'beta', event: 'agent:post-tool', matcher: 'Read',
    run: { script: 'record-beta.mjs' },
  });
  const pi = makeBridge();
  await pi.emit('tool_result', toolResult('read', 'read-2'), fixture.ctx);
  assert.deepEqual(
    readLabels(fixture.logFile),
    ['update', 'alpha', 'web', 'mcp', 'native', 'alpha', 'beta'],
  );
}

test('PI hook registration and dispatch follow fixture registry entries', async (t) => {
  const fixture = setupFixture(t);
  writeRecorderScripts();
  writeBaseEntries(fixture.registryDir);
  writeLifecycleEntries(fixture.registryDir);
  const pi = makeBridge();
  assertRegistrations(pi);
  await verifyInitialDispatch(pi, fixture);
  await verifyAddedEntry(fixture);
});
