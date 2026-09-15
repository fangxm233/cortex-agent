/**
 * Shared fixtures for tests/orch/thread-golden.test.ts (characterization goldens for the
 * thread-run pipeline). Kept out of the golden file so the 10 goldens read as pure
 * observe-and-lock assertions.
 *
 * Provenance of every technique here (nothing invented):
 *  - thread-template JSON written into CONFIG_DIR + loadConfig(): tests/webhook-thread-control.test.ts
 *  - mergeThreadTemplates(defaults, CONFIG_DIR) to seed the shipped `scheduler` template:
 *    tests/task-dispatcher.test.ts
 *  - fakeRun()/agentResult() AgentRun doubles for a mocked @domain/runs/service#startRun:
 *    tests/orch/turn-golden.test.ts
 *  - TracingAdapter subclass of MockAdapter for an interleaved post/update trace:
 *    tests/orch/turn-golden.test.ts
 *  - waitFor() polling on a bus delta / store status: tests/task-dispatch-hooks.test.ts
 *  - in-store ThreadRecord literal: tests/thread-runner.test.ts, tests/webhook-thread-control.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'vitest';

import { CONFIG_DIR } from '../../src/core/paths.js';
import { loadConfig, mergeThreadTemplates } from '../../src/domain/threads/template-loader.js';
import { MockAdapter } from '../../src/platform/testing.js';
import type { AgentRun } from '../../src/domain/runs/run.js';
import type { Destination, MessageContent, MessageRef, PostMessageOpts } from '../../src/platform/types.js';
import type { ThreadRecord } from '../../src/core/types/thread-types.js';

// --- thread-template fixtures ---------------------------------------------------------------

function writeEntity(kind: 'agents' | 'templates', name: string, data: unknown): void {
  const p = path.join(CONFIG_DIR, 'thread-templates', kind, `${name}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

/** A single-step agent slot. `name` must equal the filename or template-loader skips the file. */
export function writeGoldenAgent(name: string): void {
  writeEntity('agents', name, {
    name, profile: '__active__', persistSession: false,
    directive: 'golden characterization fixture', promptTemplate: '{{input}}',
  });
}

/** A template over `agents`, chained head→tail with unconditional transitions. */
export function writeGoldenTemplate(name: string, agents: string[]): void {
  writeEntity('templates', name, {
    name, description: 'golden characterization fixture', agents,
    transitions: agents.slice(0, -1).map((from, i) => ({
      from, to: agents[i + 1], condition: { type: 'always' },
    })),
    entryAgent: agents[0], maxTotalSteps: agents.length,
  });
}

/** Seed the shipped defaults (for the `scheduler` template + `scheduler-main` agent that the
 *  scheduled-task job hardcodes) and then the golden-only entities, in one loadConfig(). */
export function installGoldenTemplates(): void {
  mergeThreadTemplates(
    path.resolve(process.cwd(), 'defaults/config/thread-templates'),
    path.join(CONFIG_DIR, 'thread-templates'),
  );
  writeGoldenAgent('golden-solo');
  writeGoldenAgent('golden-a1');
  writeGoldenAgent('golden-a2');
  writeGoldenTemplate('golden-solo-tpl', ['golden-solo']);
  writeGoldenTemplate('golden-pair', ['golden-a1', 'golden-a2']);
  loadConfig();
}

// --- startRun doubles ------------------------------------------------------------------------

/** Minimal AgentRun shape the thread runner touches: executionId, backendSessionId, result. */
export function fakeRun(result: Promise<unknown>): AgentRun {
  return {
    id: 'golden-run', executionId: 'golden-exec', status: 'running', phase: 'foreground',
    numTurns: null, backendSessionId: 'golden-backend', capabilities: new Set(),
    result,
    // settled must never reject — runThread awaits it on teardown paths.
    settled: result.then(() => undefined, () => undefined),
    steer: async () => 'refused', respondToDialog: () => false, cancel: () => {},
    subscribe: () => () => {}, backgroundTranscriptOwned: false,
    claimBackgroundTranscript: () => {}, ingestExternal: () => false,
  } as unknown as AgentRun;
}

export function agentResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    finalOutput: 'golden output', total_cost_usd: 0.01, num_turns: 2,
    sessionId: 'golden-backend', pendingBackgroundTasks: 0, undeliveredBackgroundTasks: 0,
    ...over,
  };
}

export function cancelledError(message = 'cancelled by user'): Error & { cancelled: boolean } {
  const e = new Error(message) as Error & { cancelled: boolean };
  e.cancelled = true;
  return e;
}

// --- adapter tracing ------------------------------------------------------------------------

export interface TraceOp {
  kind: 'post' | 'update';
  dest: string | null;
  text: unknown;
  blocks: boolean;
}

/** MockAdapter plus an INTERLEAVED op log. `posted`/`updated` alone cannot express the
 *  relative order of a post and an update, which is exactly what the refactor may move. */
export class TracingAdapter extends MockAdapter {
  ops: TraceOp[] = [];

  async postMessage(dest: Destination, content: MessageContent, opts?: PostMessageOpts): Promise<MessageRef> {
    this.ops.push({ kind: 'post', dest: dest.type, text: content.text, blocks: !!content.richBlocks });
    return super.postMessage(dest, content, opts);
  }

  async updateMessage(ref: MessageRef, content: MessageContent): Promise<void> {
    this.ops.push({ kind: 'update', dest: null, text: content.text, blocks: !!content.richBlocks });
    return super.updateMessage(ref, content);
  }
}

/** Assert one golden: the interleaved op sequence AND, derived from it, the whole
 *  `adapter.posted` / `adapter.updated` arrays. Order and call count are exact in all three. */
export function expectOps(adapter: TracingAdapter, expected: TraceOp[]): void {
  expect(adapter.ops).toEqual(expected);
  expect(adapter.posted.map((p) => ({
    kind: 'post' as const, dest: p.destination.type, text: p.content.text,
    blocks: !!p.content.richBlocks,
  }))).toEqual(expected.filter((o) => o.kind === 'post'));
  expect(adapter.updated.map((u) => ({
    kind: 'update' as const, dest: null, text: u.content.text, blocks: !!u.content.richBlocks,
  }))).toEqual(expected.filter((o) => o.kind === 'update'));
}

export const post = (dest: string, text: unknown, blocks = false): TraceOp =>
  ({ kind: 'post', dest, text, blocks });
export const update = (text: unknown, blocks = false): TraceOp =>
  ({ kind: 'update', dest: null, text, blocks });

// --- misc -----------------------------------------------------------------------------------

export async function waitFor(predicate: () => boolean, label = 'condition', timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Let all already-queued microtasks/timers drain so a fire-and-forget tail cannot land
 *  after the assertions (and thus silently escape the golden). */
export async function settleTails(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 10));
}

/** A live (non-terminal) thread record, for wait-target fixtures. */
export function makeLiveThread(id: string, channel: string): ThreadRecord {
  const now = new Date().toISOString();
  return {
    id, templateName: null, status: 'running', channel, projectId: 'general',
    platformThreadId: null, userMessage: 'golden child', userMessageTs: 'ts', workspacePath: '',
    artifactPath: '', agents: {}, activeAgent: 'main', activeStage: null, currentStepIndex: 0,
    steps: [], iterationCounts: {}, totalCostUsd: 0, createdAt: now, updatedAt: now,
    endedAt: null, error: null, abortReason: null, metadata: null,
  } as unknown as ThreadRecord;
}
