// input:  node:test, thread-hook-runner, threadStore, MockAdapter
// output: RunThreadOptions.extraHooks type + runtime serial order regression
// pos:    per-call extraHooks injection mechanism regression test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DATA_DIR } from '../src/core/utils.js';
import { threadStore } from '../src/store/thread-repo.js';
import { executeLifecycleHook } from '../src/domain/threads/hook-runner.js';
import { MockAdapter } from '../src/platform/testing.js';
import type { ThreadRecord, RunThreadOptions, ThreadHookConfig } from '../src/core/types/thread-types.js';

// --- threads.json backup / restore so tests do not pollute production state ---

const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
let threadsBackup: string | null = null;
let threadsBackupExisted = false;
const testThreadIds = new Set<string>();
let tmpRoot: string;

beforeAll(() => {
  try {
    threadsBackup = fs.readFileSync(THREADS_FILE, 'utf8');
    threadsBackupExisted = true;
  } catch {
    threadsBackup = null;
    threadsBackupExisted = false;
  }
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-extra-hooks-'));
});

afterAll(async () => {
  if (threadsBackupExisted && threadsBackup != null) {
    fs.writeFileSync(THREADS_FILE, threadsBackup);
  } else {
    try { fs.unlinkSync(THREADS_FILE); } catch {}
  }
  for (const id of testThreadIds) await threadStore.delete(id);
  await threadStore.flush();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

process.on('exit', () => {
  if (threadsBackupExisted && threadsBackup != null) {
    try { fs.writeFileSync(THREADS_FILE, threadsBackup); } catch {}
  }
});

function makeThreadRecord(id: string, channel: string): ThreadRecord {
  const now = new Date().toISOString();
  return {
    id,
    templateName: null,
    status: 'running',
    channel,
    projectId: 'general',
    platformThreadId: null,
    userMessage: 'hello',
    userMessageTs: '111.000',
    workspacePath: '',
    artifactPath: '',
    agents: {
      main: {
        slotId: 'main', profile: '__active__', sessionId: null, sessionName: null,
        status: 'idle', lastOutput: null, persistSession: false,
      },
    },
    activeAgent: 'main',
    activeStage: null,
    currentStepIndex: 0,
    steps: [],
    iterationCounts: {},
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    error: null,
    abortReason: null,
    metadata: null,
  };
}

function registerTestThread(record: ThreadRecord): void {
  testThreadIds.add(record.id);
  threadStore.set(record);
}

function uniqueThreadId(prefix: string): string {
  return `thr_test-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeRunOpts(channel: string, overrides: Partial<RunThreadOptions> = {}): RunThreadOptions {
  return {
    adapter: new MockAdapter() as any,
    channel,
    destination: { type: 'interactive-reply', conduit: channel, sessionId: '' },
    threadAnchorId: null,
    statusMsg: null,
    startTime: Date.now(),
    onProgress: null,
    ...overrides,
  };
}

/**
 * Writes a tiny posix shell hook script that appends its first arg to a marker file, then outputs
 * the JSON result `{"insertAgent": false}` so the hook runner treats it as a successful no-op hook.
 * Returns the absolute script path.
 */
function writeMarkerHookScript(dir: string, name: string, markerFile: string): string {
  const scriptPath = path.join(dir, `${name}.sh`);
  const body = [
    '#!/usr/bin/env bash',
    'set -e',
    // Drain stdin (hook-runner writes HookContext JSON; we ignore it).
    'cat > /dev/null',
    `echo "$1" >> ${JSON.stringify(markerFile)}`,
    'echo \'{"insertAgent": false}\'',
    '',
  ].join('\n');
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

// --- (A) Type contract: RunThreadOptions.extraHooks accepts per-phase ThreadHookConfig ---
// This test exists only to assert the compile-time shape. If someone removes or renames extraHooks,
// `tsc --noEmit` (the project's type-check step) catches it before runtime.

test('RunThreadOptions.extraHooks compiles with per-phase ThreadHookConfig entries', () => {
  const hookConfig: ThreadHookConfig = { command: 'bash /does/not/matter.sh' };
  const opts: RunThreadOptions = {
    adapter: new MockAdapter() as any,
    channel: 'C-type-check',
    destination: { type: 'interactive-reply', conduit: 'C-type-check', sessionId: '' },
    threadAnchorId: null,
    statusMsg: null,
    startTime: 0,
    extraHooks: {
      onStart: hookConfig,
      onTransition: hookConfig,
      onEnd: hookConfig,
    },
  };
  // Runtime assertion: the field survived into the object (guards against accidental stripping
  // via `Omit` / spread misuse in callers that build options through a helper).
  assert.ok(opts.extraHooks);
  assert.equal(opts.extraHooks?.onEnd?.command, 'bash /does/not/matter.sh');
});

test('RunThreadOptions.extraHooks is optional (omitting it still type-checks)', () => {
  const opts: RunThreadOptions = {
    adapter: new MockAdapter() as any,
    channel: 'C-type-check-2',
    destination: { type: 'interactive-reply', conduit: 'C-type-check-2', sessionId: '' },
    threadAnchorId: null,
    statusMsg: null,
    startTime: 0,
  };
  assert.equal(opts.extraHooks, undefined);
});

// --- (B) Runtime: executeLifecycleHook is a no-op when hookConfig is undefined ---
// This is the invariant the patch relies on: thread-runner can call executeLifecycleHook twice
// per phase unconditionally (once for template.hooks, once for extraHooks), and missing configs
// cost nothing.

test('executeLifecycleHook with undefined config resolves without spawning anything', async () => {
  const id = uniqueThreadId('hook-undef');
  registerTestThread(makeThreadRecord(id, 'C-hook-undef'));
  // No marker should be produced. Just prove the call returns without throwing.
  await executeLifecycleHook(id, 'end', undefined, makeRunOpts('C-hook-undef'));
});

// --- (C) Runtime: executeLifecycleHook runs the configured script and receives a HookContext ---
// Proves the core of the extraHooks wiring: when a caller passes opts.extraHooks.onEnd, the
// resulting executeLifecycleHook call actually spawns the script.

test('executeLifecycleHook spawns the configured script and the script sees its args', async () => {
  const id = uniqueThreadId('hook-spawn');
  registerTestThread(makeThreadRecord(id, 'C-hook-spawn'));
  const markerFile = path.join(tmpRoot, `marker-${id}.log`);
  const scriptPath = writeMarkerHookScript(tmpRoot, `hook-spawn-${id}`, markerFile);

  const hookConfig: ThreadHookConfig = { command: `bash ${scriptPath}`, args: ['extra-marker'] };
  await executeLifecycleHook(id, 'end', hookConfig, makeRunOpts('C-hook-spawn'));

  assert.ok(fs.existsSync(markerFile), 'hook script should have been executed and written the marker file');
  assert.equal(fs.readFileSync(markerFile, 'utf8').trim(), 'extra-marker');
});

// --- (C2) Runtime: the template-then-extra pattern runs both hooks in order ---
// This mirrors exactly what the patched thread-runner does at each phase:
//   await executeLifecycleHook(..., template.hooks.onEnd, opts)
//   await executeLifecycleHook(..., opts.extraHooks.onEnd, opts)
// The marker file accumulates one line per invocation, so the ordering is directly observable.

test('template hook followed by extra hook records both invocations in order', async () => {
  const id = uniqueThreadId('hook-ordered');
  registerTestThread(makeThreadRecord(id, 'C-hook-ordered'));
  const markerFile = path.join(tmpRoot, `marker-ordered-${id}.log`);
  const scriptPath = writeMarkerHookScript(tmpRoot, `hook-ordered-${id}`, markerFile);

  const templateHook: ThreadHookConfig = { command: `bash ${scriptPath}`, args: ['template'] };
  const extraHook: ThreadHookConfig = { command: `bash ${scriptPath}`, args: ['extra'] };

  await executeLifecycleHook(id, 'end', templateHook, makeRunOpts('C-hook-ordered'));
  await executeLifecycleHook(id, 'end', extraHook, makeRunOpts('C-hook-ordered'));

  const contents = fs.readFileSync(markerFile, 'utf8').trim().split('\n');
  assert.deepEqual(contents, ['template', 'extra'], 'template hook must run before extra hook');
});

// --- (C3) Regression: hook config can invoke a non-executable .mjs via `node` in the command string ---
// The original bug (2026-04-24): task-status-check.mjs shipped with mode 644. thread-hook-runner used
// to spawn the script path directly, so EVERY onEnd hook failed with EACCES and the task-completion
// reminder never fired — tasks stayed [in-progress] forever. The fix moves the invocation prefix
// (e.g. "node ") into the config itself so +x is no longer a silent requirement.

test('hook command "node <script.mjs>" runs a script that lacks the executable bit', async () => {
  const id = uniqueThreadId('hook-node-noexec');
  registerTestThread(makeThreadRecord(id, 'C-hook-node-noexec'));
  const markerFile = path.join(tmpRoot, `marker-node-noexec-${id}.log`);
  const scriptPath = path.join(tmpRoot, `hook-node-noexec-${id}.mjs`);
  const body = [
    '#!/usr/bin/env node',
    'import { writeFileSync } from "node:fs";',
    'let ctx = "";',
    'for await (const chunk of process.stdin) ctx += chunk;',
    `writeFileSync(${JSON.stringify(markerFile)}, process.argv[2] + "\\n");`,
    'console.log(JSON.stringify({ insertAgent: false }));',
    '',
  ].join('\n');
  fs.writeFileSync(scriptPath, body, { mode: 0o644 }); // NOT executable

  const hookConfig: ThreadHookConfig = {
    command: `node ${scriptPath}`,
    args: ['ran-via-node'],
  };
  await executeLifecycleHook(id, 'end', hookConfig, makeRunOpts('C-hook-node-noexec'));

  assert.ok(fs.existsSync(markerFile), 'non-executable .mjs must still run when command starts with "node"');
  assert.equal(fs.readFileSync(markerFile, 'utf8').trim(), 'ran-via-node');
});

test('extra hook still fires when no template hook is configured (undefined template path)', async () => {
  const id = uniqueThreadId('hook-extra-only');
  registerTestThread(makeThreadRecord(id, 'C-hook-extra-only'));
  const markerFile = path.join(tmpRoot, `marker-extra-only-${id}.log`);
  const scriptPath = writeMarkerHookScript(tmpRoot, `hook-extra-only-${id}`, markerFile);

  const extraHook: ThreadHookConfig = { command: `bash ${scriptPath}`, args: ['extra-only'] };

  // Template side: undefined (no-op). Extra side: runs.
  await executeLifecycleHook(id, 'end', undefined, makeRunOpts('C-hook-extra-only'));
  await executeLifecycleHook(id, 'end', extraHook, makeRunOpts('C-hook-extra-only'));

  const contents = fs.readFileSync(markerFile, 'utf8').trim().split('\n');
  assert.deepEqual(contents, ['extra-only']);
});
