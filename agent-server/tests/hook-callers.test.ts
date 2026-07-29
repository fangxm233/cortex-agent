// input:  HookBus, thread adapter, session registry, agent doubles
// output: lifecycle, session diagnostics, and injection regressions
// pos:    Verifies public hook callers and prompt injection
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR, HOOKS_DIR } from '../src/core/paths.js';
import * as hookBus from '../src/core/hook-bus.js';
import type { AgentHandle } from '../src/core/types/agent-types.js';
import type { OutputStream } from '../src/platform/output-stream.js';
import { MockAdapter } from '../src/platform/testing.js';
import { threadStore } from '../src/store/thread-repo.js';
import { executeLifecycleHook } from '../src/domain/threads/hook-runner.js';
import {
  isOnMessageEndHookConfigured,
  isOnNewHookConfigured,
  loadHookConfig,
  runSessionHook,
  type InjectDeps,
  type SessionHookSpec,
} from '../src/domain/sessions/session-hooks.js';
import { loadHookRegistry, type HookEntry } from '../src/store/hook-registry.js';
import type {
  RunThreadOptions,
  ThreadHookConfig,
  ThreadRecord,
} from '../src/core/types/thread-types.js';

const threadIds: string[] = [];

interface RecordingStream extends OutputStream {
  texts: string[];
  flushCount: number;
}

function makeThreadRecord(id: string): ThreadRecord {
  const now = new Date().toISOString();
  return {
    id, templateName: null, status: 'running', channel: 'C-hook-caller', projectId: 'general',
    platformThreadId: null, userMessage: 'test', userMessageTs: '1', workspacePath: '', artifactPath: '',
    agents: { main: {
      slotId: 'main', profile: '__active__', sessionId: null, sessionName: null,
      status: 'idle', lastOutput: null, persistSession: false,
    } },
    activeAgent: 'main', activeStage: null, currentStepIndex: 0, steps: [], iterationCounts: {},
    totalCostUsd: 0, createdAt: now, updatedAt: now, endedAt: null, error: null,
    abortReason: null, metadata: null,
  };
}

function makeThreadOptions(adapter: MockAdapter): RunThreadOptions {
  return {
    adapter,
    channel: 'C-hook-caller',
    destination: { type: 'interactive-reply', conduit: 'C-hook-caller', sessionId: '' },
    threadAnchorId: null,
    statusMsg: null,
    startTime: Date.now(),
  };
}

async function runThreadHook(config: ThreadHookConfig) {
  const id = `thr_hook-caller-${threadIds.length}`;
  const adapter = new MockAdapter();
  const errors: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values) => {
    errors.push(values.map(String).join(' '));
  });
  threadIds.push(id);
  threadStore.set(makeThreadRecord(id));
  try {
    await executeLifecycleHook(id, 'end', config, makeThreadOptions(adapter));
  } finally {
    errorSpy.mockRestore();
  }
  return { adapter, errors, steps: threadStore.get(id)?.steps ?? [] };
}

function writeSessionHooks(
  entries: HookEntry[],
  scripts: Record<string, string> = {},
): void {
  const registryDir = path.join(CONFIG_DIR, 'hooks');
  rmSync(registryDir, { recursive: true, force: true });
  rmSync(HOOKS_DIR, { recursive: true, force: true });
  mkdirSync(registryDir, { recursive: true });
  mkdirSync(HOOKS_DIR, { recursive: true });
  entries.forEach((entry, index) => {
    const file = `${String(index + 1).padStart(2, '0')}-${entry.id}.json`;
    writeFileSync(path.join(registryDir, file), `${JSON.stringify(entry)}\n`);
  });
  for (const [file, source] of Object.entries(scripts)) {
    writeFileSync(path.join(HOOKS_DIR, file), source);
  }
  hookBus.initHookBus({ entries: loadHookRegistry(registryDir), hooksDir: HOOKS_DIR });
}

function messageEndEntry(command: string): HookEntry {
  return {
    id: 'session-message-end-hook',
    event: 'cortex:session.messageEnd',
    run: { command, timeout: 1 },
    result: 'stdout-as-prompt',
  };
}

function makeStream(): RecordingStream {
  const stream: RecordingStream = {
    texts: [],
    flushCount: 0,
    emitText(text) { stream.texts.push(text); },
    openMutable() { return { update: () => {} }; },
    async postInteractive() { return null; },
    async flush() { stream.flushCount++; },
    getRefs() { return []; },
    getParentRef() { return null; },
  };
  return stream;
}

function makeSessionSpec(): SessionHookSpec {
  return {
    name: 'onMessageEnd',
    ctx: { channel: 'C-session-hook', sessionId: 'sess-1', sessionName: 'session-one' },
    format: {
      statusLine: () => 'status',
      previewLine: output => `preview:${output}`,
      errorLine: error => `error:${error}`,
      emptyLine: () => 'empty',
    },
  };
}

function makeInjectedSpec(): SessionHookSpec {
  const spec = makeSessionSpec();
  spec.inject = {
    targetSessionId: 'sess-target',
    profileName: 'review-profile',
    sessionKey: spec.ctx.channel,
    trigger: 'hook:onMessageEnd',
  };
  return spec;
}

function makeInjectDeps() {
  const calls: Array<{ message: string; options: Parameters<InjectDeps['runAgent']>[1] }> = [];
  const closeCalls: Array<{ channel: string; sessionKey: string }> = [];
  const deps: InjectDeps = {
    runAgent(message, options): AgentHandle {
      calls.push({ message, options });
      options.onAssistantMessage?.('agent follow-up');
      return { promise: Promise.resolve(null as never), kill: () => false, sessionId: 'agent-session' };
    },
    async closeInjectedSession(channel, sessionKey) {
      closeCalls.push({ channel, sessionKey });
    },
  };
  return { deps, calls, closeCalls };
}

afterAll(async () => {
  for (const id of threadIds) await threadStore.delete(id);
  await threadStore.flush();
});

test('thread public path suppresses hook agents after a non-zero exit', async () => {
  const result = await runThreadHook({ command: 'node -e', args: ['process.exit(9)'] });

  assert.equal(result.steps.length, 0);
  assert.equal(result.adapter.posted.length, 0);
  assert.match(result.errors.join('\n'), /exited with code 9/);
});

test('thread public path suppresses hook agents after malformed JSON', async () => {
  const result = await runThreadHook({
    command: 'node -e',
    args: ["process.stdout.write('not json')"],
  });

  assert.equal(result.steps.length, 0);
  assert.equal(result.adapter.posted.length, 0);
  assert.match(result.errors.join('\n'), /Hook .* failed: .*not valid JSON/);
});

test('thread public path rejects JSON missing insertAgent and targetAgent', async () => {
  const result = await runThreadHook({
    command: 'node -e',
    args: ["process.stdout.write(JSON.stringify({ prompt: 'ignored' }))"],
  });

  assert.equal(result.steps.length, 0);
  assert.equal(result.adapter.posted.length, 0);
  assert.match(result.errors.join('\n'), /missing insertAgent or targetAgent/);
});

test('session config lookup normalizes registry scripts, commands, and timeout units', () => {
  writeSessionHooks([{
    id: 'session-new-hook',
    event: 'cortex:session.new',
    run: { script: 'new-hook.mjs', timeout: 2.5 },
    result: 'stdout-as-prompt',
  }]);

  assert.deepEqual(loadHookConfig('onNew'), {
    command: `node ${path.join(HOOKS_DIR, 'new-hook.mjs')}`,
    timeout: 2_500,
  });
  assert.equal(isOnNewHookConfigured(), true);
  assert.equal(isOnMessageEndHookConfigured(), false);

  writeSessionHooks([messageEndEntry('printf command-is-verbatim')]);
  assert.deepEqual(loadHookConfig('onMessageEnd'), {
    command: 'printf command-is-verbatim',
    timeout: 1_000,
  });
});

test('session public path requests the legacy timeout for omitted registry values', async (t) => {
  writeSessionHooks([{
    id: 'session-message-end-hook',
    event: 'cortex:session.messageEnd',
    run: { command: "node -e 'process.exit(0)'" },
    result: 'stdout-as-prompt',
  }]);
  const emitSpy = vi.spyOn(hookBus, 'emitCortexEvent');
  t.onTestFinished(() => emitSpy.mockRestore());

  await runSessionHook(makeSessionSpec(), makeStream());

  assert.equal(emitSpy.mock.calls[0]?.[2]?.defaultTimeoutMs, 60_000);
});

test('session public path formats a delegated process error and flushes', async () => {
  writeSessionHooks([messageEndEntry("node -e 'process.exit(6)'")]);
  const stream = makeStream();

  await runSessionHook(makeSessionSpec(), stream);

  assert.deepEqual(stream.texts, ['status', 'error:exited with code 6']);
  assert.equal(stream.flushCount, 1);
});

test('session public path formats empty successful output and flushes', async () => {
  writeSessionHooks([messageEndEntry("node -e 'process.exit(0)'")]);
  const stream = makeStream();

  await runSessionHook(makeSessionSpec(), stream);

  assert.deepEqual(stream.texts, ['status', 'empty']);
  assert.equal(stream.flushCount, 1);
});

test('session public path preserves env, preview, stderr warning, and flush', async () => {
  const source = [
    'process.stdout.write([process.env.CORTEX_HOOK_CHANNEL, process.env.CORTEX_HOOK_SESSION_ID,',
    'process.env.CORTEX_HOOK_TRIGGER].join("|"));',
    'process.stderr.write("session warning");',
  ].join('');
  writeSessionHooks([messageEndEntry(`node -e '${source}'`)]);
  const stream = makeStream();
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  let warnings = '';
  try {
    await runSessionHook(makeSessionSpec(), stream);
    warnings = warnSpy.mock.calls.flat().map(String).join(' ');
  } finally {
    warnSpy.mockRestore();
  }

  assert.deepEqual(stream.texts, ['status', 'preview:C-session-hook|sess-1|messageEnd']);
  assert.equal(stream.flushCount, 1);
  assert.match(warnings, /session warning/);
});

test('session event injects only prompt results with preserved agent context', async () => {
  const marker = path.join(HOOKS_DIR, 'injection-observer-ran');
  writeSessionHooks([
    messageEndEntry("node -e 'process.stdout.write(\"inject me\")'"),
    {
      id: 'session-observer',
      event: 'cortex:session.messageEnd',
      run: { script: 'observer.mjs', timeout: 1 },
      result: 'none',
    },
  ], {
    'observer.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes');\n`,
  });
  const stream = makeStream();
  const { deps, calls, closeCalls } = makeInjectDeps();
  const spec = makeInjectedSpec();

  await runSessionHook(spec, stream, deps);

  assert.equal(existsSync(marker), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, 'inject me');
  assert.equal(calls[0].options.channel, spec.ctx.channel);
  assert.equal(calls[0].options.sessionId, 'sess-target');
  assert.equal(calls[0].options.profileName, 'review-profile');
  assert.equal(calls[0].options.sessionKey, spec.ctx.channel);
  assert.deepEqual(closeCalls, []);
  assert.deepEqual(stream.texts, ['status', 'preview:inject me', 'agent follow-up']);
  assert.equal(stream.flushCount, 1);
});

test('session event dispatches result-less subscribers without extra UX lines', async () => {
  const marker = path.join(HOOKS_DIR, 'observer-ran');
  writeSessionHooks([
    messageEndEntry("node -e 'process.stdout.write(\"primary\")'"),
    {
      id: 'session-observer',
      event: 'cortex:session.messageEnd',
      run: { script: 'observer.mjs', timeout: 1 },
      result: 'none',
    },
  ], {
    'observer.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes');\n`,
  });
  const stream = makeStream();

  await runSessionHook(makeSessionSpec(), stream);

  assert.equal(existsSync(marker), true);
  assert.deepEqual(stream.texts, ['status', 'preview:primary']);
  assert.equal(stream.flushCount, 1);
});
