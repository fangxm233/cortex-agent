// input:  PI hook bridge, tool shims, fixture hook processes
// output: PI registry, native contract, and interaction regressions
// pos:    Verifies ordered PI hook registration and dispatch
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'vitest';

import hookBridge from '../src/agent-adapter/pi/hook-bridge.js';
import toolShims from '../src/agent-adapter/pi/tool-shims.js';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '../src/agent-adapter/pi/pi-ext-types.js';
import { CONFIG_DIR, DEFAULTS_DIR, HOOKS_DIR } from '../src/core/paths.js';

type Handler = (event: any, ctx: ExtensionContext) => any;

class FakePi implements Pick<ExtensionAPI, 'on' | 'registerTool'> {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, any>();

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerTool(definition: any): void {
    this.tools.set(definition.name, definition);
  }

  private async emitDefault(event: string, payload: any, ctx: ExtensionContext): Promise<unknown> {
    let result: any;
    for (const handler of this.handlers.get(event) ?? []) {
      const next = await handler(payload, ctx);
      if (next === undefined) continue;
      result = next;
      if (event.startsWith('session_before_') && next.cancel === true) return next;
    }
    return result;
  }

  private async emitContext(payload: any, ctx: ExtensionContext): Promise<unknown[]> {
    let messages = payload.messages;
    for (const handler of this.handlers.get('context') ?? []) {
      const result = await handler({ ...payload, messages }, ctx);
      if (result?.messages) messages = result.messages;
    }
    return messages;
  }

  private async emitProvider(payload: any, ctx: ExtensionContext): Promise<unknown> {
    let current = payload.payload;
    for (const handler of this.handlers.get('before_provider_request') ?? []) {
      const result = await handler({ ...payload, payload: current }, ctx);
      if (result !== undefined) current = result;
    }
    return current;
  }

  private async emitMessageEnd(payload: any, ctx: ExtensionContext): Promise<unknown> {
    let message = payload.message;
    let modified = false;
    for (const handler of this.handlers.get('message_end') ?? []) {
      const result = await handler({ ...payload, message }, ctx);
      if (!result?.message) continue;
      message = result.message;
      modified = true;
    }
    return modified ? message : undefined;
  }

  private async emitBeforeAgent(payload: any, ctx: ExtensionContext): Promise<unknown> {
    let systemPrompt = payload.systemPrompt;
    const messages: unknown[] = [];
    let modified = false;
    for (const handler of this.handlers.get('before_agent_start') ?? []) {
      const result = await handler({ ...payload, systemPrompt }, ctx);
      if (result?.message) messages.push(result.message);
      if (result?.systemPrompt === undefined) continue;
      systemPrompt = result.systemPrompt;
      modified = true;
    }
    if (messages.length === 0 && !modified) return undefined;
    return { messages: messages.length > 0 ? messages : undefined, systemPrompt };
  }

  private async emitToolResult(payload: any, ctx: ExtensionContext): Promise<unknown> {
    const current = { ...payload };
    let modified = false;
    for (const handler of this.handlers.get('tool_result') ?? []) {
      const result = await handler(current, ctx);
      if (!result) continue;
      for (const key of ['content', 'details', 'isError', 'usage']) {
        if (result[key] === undefined) continue;
        current[key] = result[key];
        modified = true;
      }
    }
    if (!modified) return undefined;
    return Object.fromEntries(
      ['content', 'details', 'isError', 'usage'].map((key) => [key, current[key]]),
    );
  }

  private async emitHeaders(payload: any, ctx: ExtensionContext): Promise<unknown> {
    for (const handler of this.handlers.get('before_provider_headers') ?? []) {
      await handler(payload, ctx);
    }
    return payload.headers;
  }

  async emit(event: string, payload: any, ctx: ExtensionContext): Promise<unknown> {
    if (event === 'context') return this.emitContext(payload, ctx);
    if (event === 'before_provider_request') return this.emitProvider(payload, ctx);
    if (event === 'message_end') return this.emitMessageEnd(payload, ctx);
    if (event === 'before_agent_start') return this.emitBeforeAgent(payload, ctx);
    if (event === 'before_provider_headers') return this.emitHeaders(payload, ctx);
    if (event === 'tool_result') return this.emitToolResult(payload, ctx);
    return this.emitDefault(event, payload, ctx);
  }
}

function makeCtx(input: () => Promise<string | null> = async () => null): ExtensionContext {
  return {
    signal: undefined,
    cwd: process.cwd(),
    ui: {
      select: async () => null,
      confirm: async () => null,
      input,
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

function writeResponder(filename: string, label: string, expression: string): void {
  const source = [
    "import { appendFileSync } from 'node:fs';",
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    "const payload = JSON.parse(input);",
    `appendFileSync(process.env.PI_HOOK_TEST_LOG, JSON.stringify({ label: ${JSON.stringify(label)}, payload }) + '\\n');`,
    `process.stdout.write(JSON.stringify(${expression}));`,
  ].join('\n');
  fs.writeFileSync(path.join(HOOKS_DIR, filename), `${source}\n`);
}

interface LogRecord {
  label: string;
  payload: Record<string, unknown>;
}

function readRecords(logFile: string): LogRecord[] {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord);
}

function readLabels(logFile: string): string[] {
  return readRecords(logFile).map((record) => record.label);
}

const LIFECYCLE_EVENTS = [
  ['04-session-start.json', 'agent:session-start', 'before_agent_start', 'SessionStart'],
  ['05-session-end.json', 'agent:session-end', 'session_shutdown', 'SessionEnd'],
  ['06-pre-compact.json', 'agent:pre-compact', 'session_before_compact', 'PreCompact'],
  ['07-user-prompt.json', 'agent:user-prompt', 'input', 'UserPromptSubmit'],
  ['08-turn-end.json', 'agent:turn-end', 'turn_end', 'Stop'],
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
  fs.rmSync(logFile, { force: true });
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
  for (const [filename, event, nativeEvent] of LIFECYCLE_EVENTS) {
    const script = `record-${nativeEvent}.mjs`;
    writeRecorder(script, nativeEvent);
    writeEntry(registryDir, filename, {
      id: filename.replace('.json', ''),
      event,
      run: { script },
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

function lifecycleEvent(eventName: string): Record<string, unknown> {
  const base = { type: eventName };
  if (eventName === 'before_agent_start') {
    return { ...base, prompt: 'start', systemPrompt: 'base' };
  }
  if (eventName === 'session_shutdown') return { ...base, reason: 'quit' };
  if (eventName === 'session_before_compact') return { ...base, reason: 'manual' };
  if (eventName === 'input') return { ...base, text: 'hello', source: 'rpc' };
  return { ...base, turnIndex: 1 };
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
  for (const [, , nativeEvent] of LIFECYCLE_EVENTS) {
    await pi.emit(nativeEvent, lifecycleEvent(nativeEvent), fixture.ctx);
  }
  const lifecycleLabels = LIFECYCLE_EVENTS.map(([, , nativeEvent]) => nativeEvent);
  assert.deepEqual(readLabels(fixture.logFile), [
    'update', 'alpha', 'web', 'mcp', 'native', ...lifecycleLabels,
  ]);
  const records = readRecords(fixture.logFile).slice(-LIFECYCLE_EVENTS.length);
  assert.deepEqual(records.map((record) => record.payload.hook_event_name),
    LIFECYCLE_EVENTS.map(([, , , hookEvent]) => hookEvent));
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
    [
      'update', 'alpha', 'web', 'mcp', 'native',
      ...LIFECYCLE_EVENTS.map(([, , nativeEvent]) => nativeEvent),
      'alpha', 'beta',
    ],
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

function readDefaultEntry(filename: string): Record<string, any> {
  const file = path.join(DEFAULTS_DIR, 'config', 'hooks', filename);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
}

function writeInteractionEntries(fixture: Fixture): void {
  const specs = [
    ['03-ask-user-question-hook.json', 'interaction-ask.mjs', 'ask',
      "({ hookSpecificOutput: { updatedInput: { ...payload.tool_input, answers: { Color: 'Blue' } } } })"],
    ['04-exit-plan-mode-hook.json', 'interaction-exit.mjs', 'exit',
      "({ hookSpecificOutput: { updatedInput: { ...payload.tool_input, notice: 'approved' } } })"],
  ] as const;
  for (const [filename, script, label, expression] of specs) {
    writeResponder(script, label, expression);
    writeEntry(fixture.registryDir, filename, {
      ...readDefaultEntry(filename),
      run: { script },
    });
  }
}

function askParams(): Record<string, unknown> {
  return {
    questions: [{
      question: 'Choose a color',
      header: 'Color',
      options: [
        { label: 'Blue', description: 'Use blue' },
        { label: 'Green', description: 'Use green' },
      ],
      multiSelect: false,
    }],
  };
}

async function executeShim(
  pi: FakePi,
  name: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
): Promise<any> {
  const tool = pi.tools.get(name);
  assert.ok(tool, `expected ${name} shim`);
  return tool.execute(`call-${name}`, params, undefined, undefined, ctx);
}

test('default interaction hooks leave PI questions and approvals to one shim response', async (t) => {
  const fixture = setupFixture(t);
  writeInteractionEntries(fixture);
  const previousTools = process.env.CORTEX_PI_ALLOWED_TOOLS;
  process.env.CORTEX_PI_ALLOWED_TOOLS = 'AskUserQuestion,ExitPlanMode';
  t.onTestFinished(() => {
    if (previousTools === undefined) delete process.env.CORTEX_PI_ALLOWED_TOOLS;
    else process.env.CORTEX_PI_ALLOWED_TOOLS = previousTools;
  });

  const answers = ['Blue', '__APPROVED__'];
  let responseCount = 0;
  const ctx = makeCtx(async () => answers[responseCount++] ?? null);
  const pi = new FakePi();
  hookBridge(pi as unknown as ExtensionAPI);
  toolShims(pi as unknown as ExtensionAPI);

  const askInput = askParams();
  await pi.emit('tool_call', { toolName: 'ask_user_question', toolCallId: 'ask', input: askInput }, ctx);
  const askResult = await executeShim(pi, 'ask_user_question', askInput, ctx);
  const exitInput = {};
  await pi.emit('tool_call', { toolName: 'exit_plan_mode', toolCallId: 'exit', input: exitInput }, ctx);
  const exitResult = await executeShim(pi, 'exit_plan_mode', exitInput, ctx);

  assert.equal(responseCount, 2);
  assert.match(askResult.content[0].text, /Blue/);
  assert.match(exitResult.content[0].text, /approved/i);
  assert.deepEqual(readLabels(fixture.logFile), []);
});

function writeNativeEntry(
  fixture: Fixture,
  filename: string,
  event: string,
  script: string,
  label: string,
  expression: string,
): void {
  writeResponder(script, label, expression);
  writeEntry(fixture.registryDir, filename, {
    id: filename.replace('.json', ''), event, run: { script },
  });
}

test('native compact hooks preserve first cancellation and stop later entries', async (t) => {
  const fixture = setupFixture(t);
  writeNativeEntry(fixture, '01-cancel.json', 'pi:session_before_compact',
    'compact-cancel.mjs', 'compact-cancel', '({ cancel: true })');
  writeNativeEntry(fixture, '02-later.json', 'pi:session_before_compact',
    'compact-later.mjs', 'compact-later', "({ compaction: { summary: 'later' } })");
  const pi = makeBridge();

  const result = await pi.emit('session_before_compact', {
    type: 'session_before_compact', reason: 'manual',
  }, fixture.ctx);

  assert.deepEqual(result, { cancel: true });
  assert.deepEqual(readLabels(fixture.logFile), ['compact-cancel']);
});

function writeReducerEntries(fixture: Fixture): void {
  const entries = [
    ['01-context-a.json', 'pi:context', 'context-a.mjs', 'context-a',
      "({ messages: [...payload.messages, { role: 'user', content: 'A' }] })"],
    ['02-context-b.json', 'pi:context', 'context-b.mjs', 'context-b',
      "({ messages: [...payload.messages, { role: 'user', content: 'B' }] })"],
    ['03-provider-a.json', 'pi:before_provider_request', 'provider-a.mjs', 'provider-a',
      '({ ...payload.payload, first: true })'],
    ['04-provider-b.json', 'pi:before_provider_request', 'provider-b.mjs', 'provider-b',
      '({ ...payload.payload, second: true })'],
    ['05-message-a.json', 'pi:message_end', 'message-a.mjs', 'message-a',
      "({ message: { ...payload.message, content: String(payload.message.content) + 'A' } })"],
    ['06-message-b.json', 'pi:message_end', 'message-b.mjs', 'message-b',
      "({ message: { ...payload.message, content: String(payload.message.content) + 'B' } })"],
  ] as const;
  for (const [filename, event, script, label, expression] of entries) {
    writeNativeEntry(fixture, filename, event, script, label, expression);
  }
}

test('native transforms chain through PI reducer ordering', async (t) => {
  const fixture = setupFixture(t);
  writeReducerEntries(fixture);
  const pi = makeBridge();

  const messages = await pi.emit('context', {
    type: 'context', messages: [{ role: 'user', content: 'base' }],
  }, fixture.ctx);
  const request = await pi.emit('before_provider_request', {
    type: 'before_provider_request', payload: { base: true },
  }, fixture.ctx);
  const message = await pi.emit('message_end', {
    type: 'message_end', message: { role: 'assistant', content: 'base' },
  }, fixture.ctx);

  assert.deepEqual(messages, [
    { role: 'user', content: 'base' },
    { role: 'user', content: 'A' },
    { role: 'user', content: 'B' },
  ]);
  assert.deepEqual(request, { base: true, first: true, second: true });
  assert.deepEqual(message, { role: 'assistant', content: 'baseAB' });
});

function writeNativeResultEntries(fixture: Fixture): void {
  writeNativeEntry(fixture, '01-start-a.json', 'pi:before_agent_start',
    'start-a.mjs', 'start-a',
    "({ message: { customType: 'a', content: 'A', display: true }, systemPrompt: payload.systemPrompt + '-A' })");
  writeNativeEntry(fixture, '02-start-b.json', 'pi:before_agent_start',
    'start-b.mjs', 'start-b',
    "({ message: { customType: 'b', content: 'B', display: true }, systemPrompt: payload.systemPrompt + '-B' })");
  writeNativeEntry(fixture, '03-tool.json', 'pi:tool_result',
    'tool-result.mjs', 'tool-result',
    "({ content: [{ type: 'text', text: 'changed' }], details: { source: 'hook' }, isError: true, usage: { input: 1, output: 2 } })");
}

test('native results retain messages and all tool result fields', async (t) => {
  const fixture = setupFixture(t);
  writeNativeResultEntries(fixture);
  const pi = makeBridge();

  const start = await pi.emit('before_agent_start', {
    type: 'before_agent_start', prompt: 'go', systemPrompt: 'base',
  }, fixture.ctx);
  const result = await pi.emit('tool_result', {
    ...toolResult('read', 'read-native'),
    details: { source: 'tool' },
    usage: { input: 0, output: 0 },
  }, fixture.ctx);

  assert.deepEqual(start, {
    messages: [
      { customType: 'a', content: 'A', display: true },
      { customType: 'b', content: 'B', display: true },
    ],
    systemPrompt: 'base-A-B',
  });
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'changed' }],
    details: { source: 'hook' },
    isError: true,
    usage: { input: 1, output: 2 },
  });
});

function writeNativeMutationEntries(fixture: Fixture): void {
  writeNativeEntry(fixture, '01-tool-call.json', 'pi:tool_call',
    'tool-call-mutation.mjs', 'tool-call-mutation',
    '({ input: { ...payload.input, changed: true }, block: false })');
  writeNativeEntry(fixture, '02-headers.json', 'pi:before_provider_headers',
    'header-mutation.mjs', 'header-mutation',
    "({ headers: { kept: 'changed', added: 'yes', removed: null } })");
}

test('native mutation events update live tool input and provider headers', async (t) => {
  const fixture = setupFixture(t);
  writeNativeMutationEntries(fixture);
  const pi = makeBridge();
  const input = { original: true };
  const headers = { kept: 'base', removed: 'old' };

  const toolResult = await pi.emit('tool_call', {
    type: 'tool_call', toolName: 'read', toolCallId: 'native-call', input,
  }, fixture.ctx);
  const headerResult = await pi.emit('before_provider_headers', {
    type: 'before_provider_headers', headers,
  }, fixture.ctx);

  assert.deepEqual(input, { original: true, changed: true });
  assert.deepEqual(toolResult, { block: false });
  assert.equal(headerResult, headers);
  assert.deepEqual(headers, { kept: 'changed', added: 'yes', removed: null });
});

function writeControlFlowEntries(fixture: Fixture): void {
  const command = `printf '%s\\n' '{"label":"command","payload":{}}' >> "$PI_HOOK_TEST_LOG"`;
  writeEntry(fixture.registryDir, '01-command.json', {
    id: 'command', event: 'pi:custom_event', run: { command },
  });
  fs.writeFileSync(path.join(HOOKS_DIR, 'timeout.mjs'), 'setTimeout(() => {}, 5_000);\n');
  writeEntry(fixture.registryDir, '02-timeout.json', {
    id: 'timeout', event: 'pi:custom_event', run: { script: 'timeout.mjs', timeout: 0.02 },
  });
  writeEntry(fixture.registryDir, '03-failure.json', {
    id: 'failure', event: 'pi:custom_event', run: { command: 'exit 7' },
  });
  writeRecorder('after-failure.mjs', 'after-failure');
  writeEntry(fixture.registryDir, '04-after.json', {
    id: 'after-failure', event: 'pi:custom_event', run: { script: 'after-failure.mjs' },
  });
}

test('command, timeout, and subprocess failure paths continue registry dispatch', async (t) => {
  const fixture = setupFixture(t);
  writeControlFlowEntries(fixture);
  const pi = makeBridge();
  const started = Date.now();

  await pi.emit('custom_event', { type: 'custom_event' }, fixture.ctx);

  assert.ok(Date.now() - started < 3_000, 'explicit timeout should stop the slow hook');
  assert.deepEqual(readLabels(fixture.logFile), ['command', 'after-failure']);
});
