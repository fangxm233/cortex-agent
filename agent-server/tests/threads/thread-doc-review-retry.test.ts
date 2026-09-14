import { afterAll, beforeAll, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const attempt = vi.hoisted(() => ({ startAttempt: vi.fn() }));

// The run layer is the spawn seam now: intercept startAttempt, not the retired agent facade.
vi.mock('@domain/runs/attempt.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, startAttempt: attempt.startAttempt };
});

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getActiveBackend: () => 'claude',
    getActiveProfile: () => 'default',
    getClaudeMode: () => 'api',
  };
});

vi.mock('@domain/agents/profile-manager.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    resolveProfileConfig: (name: string) => ({
      name,
      backend: 'claude',
      model: 'test-model',
      mode: 'api',
      provider: 'anthropic',
    }),
  };
});

import { CONFIG_DIR, DATA_DIR, DEFAULTS_DIR } from '../../src/core/paths.js';
import { initHookBus } from '../../src/core/hook-bus.js';
import { threadStore } from '../../src/store/thread-repo.js';
import {
  cleanupWorkspace,
  createThread,
  getTemplate,
  loadConfig,
} from '../../src/domain/threads/index.js';
import { runThread, type ThreadRunResult } from '../../src/domain/threads/runner.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { RunThreadOptions, ThreadRecord } from '../../src/core/types/thread-types.js';

const FIRST_THREE_STEPS = [
  ['doc-writer', 'write'],
  ['doc-reviewer', null],
  ['doc-writer', 'retry'],
];
let thread: ThreadRecord | null = null;

beforeAll(() => {
  for (const directory of ['prompts', 'plugins']) {
    fs.cpSync(path.join(DEFAULTS_DIR, directory), path.join(DATA_DIR, directory), { recursive: true });
  }
  fs.cpSync(
    path.join(DEFAULTS_DIR, 'config', 'thread-templates'),
    path.join(CONFIG_DIR, 'thread-templates'),
    { recursive: true },
  );
  loadConfig();
  const template = getTemplate('doc-review');
  assert.ok(template, 'shipped doc-review template must load');
  delete template.hooks;
  initHookBus({ entries: [], hooksDir: CONFIG_DIR });
});

afterAll(async () => {
  if (!thread) return;
  cleanupWorkspace(thread.id);
  await threadStore.delete(thread.id);
  await threadStore.flush();
});

function result(sessionId: string, output: string) {
  return { sessionId, finalOutput: output, total_cost_usd: 0, num_turns: 1 };
}

/** Synthetic `RunAttempt` for the orchestration seam. `startAttempt` now takes a `RunRequest`
 *  plus attempt config; the old handle's `sessionId` is the attempt's `backendSessionId` and the
 *  request's `session.backendSessionId`. */
function attemptShell(input: any, backendSessionId: string | null, foreground: Promise<any>) {
  return {
    engine: {
      backend: input?.request?.profile?.backend ?? 'claude',
      identity: 'test-engine',
      capabilities: new Set<string>(),
      backendSessionId,
      run: () => ({}),
      steer: () => ({ accepted: false }),
      ingestExternal: () => false,
      respondToDialog: () => false,
      compact: async () => ({}),
      close: async () => {},
      kill: () => true,
    },
    engineRun: {},
    spec: input?.request?.spec,
    backend: input?.request?.profile?.backend ?? 'claude',
    identity: null,
    foreground,
    settled: foreground,
    backendSessionId,
    kill: () => true,
  };
}

function queueStep(artifactPath: string, addition: string, sessionId: string): void {
  attempt.startAttempt.mockImplementationOnce((input: any) => {
    fs.appendFileSync(artifactPath, addition);
    return attemptShell(input, sessionId, Promise.resolve(result(sessionId, addition)));
  });
}

function makeOptions(record: ThreadRecord): RunThreadOptions {
  return {
    adapter: new MockAdapter(),
    channel: record.channel,
    destination: { type: 'interactive-reply', conduit: record.channel, sessionId: '' },
    threadAnchorId: null,
    statusMsg: null,
    startTime: Date.now(),
    onProgress: null,
  };
}

function createDocReviewThread(): ThreadRecord {
  attempt.startAttempt.mockReset();
  return createThread('C-doc-review-retry', {
    templateName: 'doc-review',
    userMessage: 'revise the document after review',
    userMessageTs: String(Date.now()),
    projectId: 'cortex-self',
  });
}

function queueInitialReviewCycle(record: ThreadRecord): void {
  const artifactPath = record.artifactPath;
  queueStep(artifactPath, '## Write Summary (iteration 1)\ninitial draft\n', 'writer-1');
  queueStep(artifactPath, '## Review (iteration 1)\nBlocker: fix provenance\n', 'reviewer-1');
  queueStep(
    artifactPath,
    '## Write Summary (iteration 2)\nfixed provenance\n[REVISED]\n',
    'writer-2',
  );
}

function queueControlledSecondReview(record: ThreadRecord) {
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const verdict = '## Review (iteration 2)\n[APPROVED]\n';
  attempt.startAttempt.mockImplementationOnce((input: any) => attemptShell(
    input,
    'reviewer-2',
    (async () => {
      signalStarted();
      await released;
      fs.appendFileSync(record.artifactPath, verdict);
      return result('reviewer-2', verdict);
    })(),
  ));
  return { started, release };
}

function assertReviewIsNonTerminal(record: ThreadRecord, artifact: string): void {
  assert.equal(record.status, 'running');
  assert.equal(record.endedAt, null);
  assert.deepEqual(
    record.steps.map((step) => [step.agentSlotId, step.stage]),
    FIRST_THREE_STEPS,
  );
  assert.doesNotMatch(artifact, /Review \(iteration 2\)/);
}

function assertCompletedReviewCycle(completed: ThreadRunResult, artifactPath: string): void {
  assert.equal(completed.thread.status, 'completed');
  assert.deepEqual(
    completed.thread.steps.map((step) => [step.agentSlotId, step.stage]),
    [...FIRST_THREE_STEPS, ['doc-reviewer', null]],
  );
  assert.equal(attempt.startAttempt.mock.calls.length, 4);
  assert.match(fs.readFileSync(artifactPath, 'utf8'), /Review \(iteration 2\)\n\[APPROVED\]/);
}

test('doc-review waits for reviewer iteration 2 after a revised retry', async () => {
  thread = createDocReviewThread();
  queueInitialReviewCycle(thread);
  const control = queueControlledSecondReview(thread);
  const runPromise = runThread(thread.id, makeOptions(thread));
  const boundary = await Promise.race([
    control.started.then(() => 'reviewer-started'),
    runPromise.then(() => 'thread-finished'),
  ]);
  assert.equal(boundary, 'reviewer-started', 'thread finished before reviewer iteration 2');
  const beforeVerdict = structuredClone(threadStore.get(thread.id)!);
  const artifactBeforeVerdict = fs.readFileSync(thread.artifactPath, 'utf8');
  control.release();
  const completed = await runPromise;
  assertReviewIsNonTerminal(beforeVerdict, artifactBeforeVerdict);
  assertCompletedReviewCycle(completed, thread.artifactPath);
});
