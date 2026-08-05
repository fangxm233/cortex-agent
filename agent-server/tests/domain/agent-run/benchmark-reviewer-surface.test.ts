// input:  the shipped benchmark reviewer document and a real snapshot-placed thread step
// output: the reviewer's read-only tool surface and its verdict-only stage prompts
// pos:    Read-only surface proof for the snapshot-placed benchmark reviewer
// >>> If I am updated, update my header and folder CORTEX.md <<<

// SEAM NOTE. The tool-surface assertion does not read the JSON twice: the document is copied into
// the live config directory and then resolved by the real template loader, the real prompt builder
// and the real step loop, so what is asserted is the surface a spawned step would carry. The far
// side of the process boundary is a real child started by the real lease-checking spawner.

import '../../_test-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  attachOptions: [] as any[],
  stepOptions: [] as { slot: string; tools: unknown; prompt: string }[],
  runAgent: vi.fn(),
}));

vi.mock('../../../src/domain/agents/index.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runAgent: harness.runAgent,
  getClaudeMode: () => 'api',
  closeSessionsByPrefix: () => {},
}));

vi.mock('../../../src/domain/agent-run/supervisor.js', async (importOriginal) => {
  const { spawnSync } = await import('node:child_process');
  return {
    ...await importOriginal<Record<string, unknown>>(),
    attachSupervisor: (options: any) => {
      harness.attachOptions.push(options);
      spawnSync(process.execPath, ['-e', ''], { cwd: options.cwd });
      return {
        process: {},
        started: Promise.resolve({ pid: 1, pgid: 1 }),
        exited: Promise.resolve({ code: 0, signal: null }),
        quiescent: Promise.resolve(),
        closed: Promise.resolve({ code: 0, signal: null }),
        cancel: () => {},
        dispose: async () => {},
      };
    },
  };
});

import { CONFIG_DIR, DATA_DIR, DEFAULTS_DIR } from '../../../src/core/paths.js';
import type { NormalizedEvent } from '../../../src/agent-adapter/normalize/event-types.js';
import type { RunAgentOptions } from '../../../src/domain/agents/facade.js';
import { openJournal } from '../../../src/domain/agent-run/journal.js';
import { writeStartedMarker } from '../../../src/domain/agent-run/manifest.js';
import { ctx as jobCtx } from '../../../src/domain/scheduling/job-registry.js';
import { profileRepo } from '../../../src/store/profile-repo.js';

const SHIPPED = path.join(DEFAULTS_DIR, 'config', 'thread-templates');
const APPROVAL_MARKER = '[IMPL-APPROVED]';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-reviewer-surface-'));
const parentJournals: any[] = [];
let previousSupervisorBinary: string | undefined;

function shippedDocument(kind: 'agents' | 'templates', name: string): any {
  return JSON.parse(fs.readFileSync(path.join(SHIPPED, kind, `${name}.json`), 'utf8'));
}

/** The shipped documents, copied byte-for-byte into the live config directory so the loader that
 *  resolves them at runtime is the one under test. */
function seedShippedDocuments(): void {
  const base = path.join(CONFIG_DIR, 'thread-templates');
  for (const [kind, name] of [
    ['agents', 'benchmark-coder'], ['agents', 'benchmark-reviewer'],
    ['templates', 'benchmark-coder-review'],
  ] as const) {
    const target = path.join(base, kind, `${name}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(SHIPPED, kind, `${name}.json`), target);
  }
  fs.mkdirSync(path.join(base, 'shells'), { recursive: true });
}

function seedProfile(): void {
  const file = path.join(CONFIG_DIR, 'profiles.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    defaultProfile: 'benchmark-fixture',
    profiles: {
      'benchmark-fixture': {
        model: 'fixture-model', backend: 'claude', claudeBackend: 'print',
        provider: 'anthropic', fallback: [],
      },
    },
  }));
  profileRepo.invalidate();
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function seedParentLifecycle(trajectoryRoot: string, rootRunId: string, workspaceCwd: string): void {
  const journal = openJournal({
    path: path.join(trajectoryRoot, `parent-${rootRunId}.journal.ndjson`),
    header: {
      rootRunId, threadId: null, agentSlot: 'parent', resolvedCwd: workspaceCwd,
      canonicalInstructionSha256: sha256Text('fix the fixture'),
      modelVisiblePromptSha256: sha256Text('fix the fixture'),
      systemPromptSha256: '1'.repeat(64), toolManifestSha256: '2'.repeat(64),
      pluginManifestSha256: '3'.repeat(64), modelExecutionIdentityHash: '6'.repeat(64),
      roleToolSurfaceHash: '4'.repeat(64), bundleManifestHash: '5'.repeat(64),
    },
  });
  journal.writeEvent({
    threadId: null, step: null, agentSlot: 'parent', backend: 'claude', provider: 'anthropic',
    requestedModel: 'fixture-model', reportedModel: null,
    event: { type: 'tool_use', toolUseId: 'thread-call', name: 'thread_run', input: {} },
  });
  parentJournals.push(journal);
  writeStartedMarker({ trajectoryRoot, rootRunId, threadId: null, journalPath: journal.path });
}

function request(name: string): any {
  const workspaceCwd = path.join(root, name, 'workspace');
  const trajectoryRoot = path.join(root, name, 'trajectory');
  fs.mkdirSync(workspaceCwd, { recursive: true });
  fs.mkdirSync(trajectoryRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceCwd, 'solution.txt'), 'shared original\n');
  const value = {
    workspaceCwd, template: 'benchmark-coder-review', instruction: 'fix the fixture',
    profileName: 'benchmark-fixture', rootRunId: `run-${name}`, trajectoryRoot,
    trialRoot: DATA_DIR, coderReviewVariant: 'audit-retry',
    limits: { maxSteps: 4, maxCostUsd: 1, deadlineEpochMs: Date.now() + 30_000 },
    signal: new AbortController().signal,
  };
  seedParentLifecycle(trajectoryRoot, value.rootRunId, workspaceCwd);
  return value;
}

/** Records the surface the real step loop built for this step, then drives one spawn through the
 *  real lease-checking spawner so the step is a step and not a stub. */
function queueStep(text: string | null): void {
  harness.runAgent.mockImplementationOnce((prompt: string, options: RunAgentOptions) => {
    harness.stepOptions.push({
      slot: String((options as any).benchmarkAgentSlot), tools: options.tools, prompt,
    });
    options.processSpawner!(process.execPath, ['-e', ''], { cwd: options.cwd, env: process.env });
    const events: NormalizedEvent[] = [];
    if (text !== null) events.push({ type: 'assistant_text', text, model: 'fixture-model' });
    events.push({ type: 'turn_complete', numTurns: 1, totalCostUsd: 0 });
    for (const event of events) {
      for (const sink of options.requiredSinks ?? []) sink.onEvent(event);
    }
    if (text !== null) options.onAssistantMessage?.(text);
    return {
      sessionId: 'fixture-session', agentProcess: null, kill: () => true,
      promise: Promise.resolve({
        finalOutput: text, sessionId: 'fixture-session', total_cost_usd: 0, num_turns: 1,
      }),
    };
  });
}

async function runBenchmarkThread(value: any): Promise<any> {
  const api = await import('../../../src/domain/agent-run/benchmark-local-thread-orchestrator.js');
  return api.runBenchmarkThread(value, {} as any);
}

beforeAll(() => {
  seedProfile();
  seedShippedDocuments();
}, 60_000);

beforeEach(() => {
  previousSupervisorBinary = process.env.CORTEX_SUPERVISOR_BINARY;
  process.env.CORTEX_SUPERVISOR_BINARY = process.execPath;
  harness.attachOptions.length = 0;
  harness.stepOptions.length = 0;
  harness.runAgent.mockReset();
  jobCtx.bus = null;
  fs.rmSync(path.join(DATA_DIR, 'tmp', 'review-snapshot'), { recursive: true, force: true });
});

afterAll(async () => {
  if (previousSupervisorBinary === undefined) delete process.env.CORTEX_SUPERVISOR_BINARY;
  else process.env.CORTEX_SUPERVISOR_BINARY = previousSupervisorBinary;
  await Promise.all(parentJournals.map(journal => journal.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

it('gives the shipped reviewer no file-writing tool', () => {
  const reviewer = shippedDocument('agents', 'benchmark-reviewer');
  const names = String(reviewer.tools).split(',');

  assert.deepEqual(names, ['Bash', 'Read', 'Glob', 'Grep', 'TodoWrite', 'Skill']);
  assert.equal(names.includes('Write'), false);
  assert.equal(names.includes('Edit'), false);
  // The coder keeps both: the surfaces differ because the placements differ, not by accident.
  const coder = shippedDocument('agents', 'benchmark-coder');
  const coderNames = String(coder.tools).split(',');
  assert.ok(coderNames.includes('Write') && coderNames.includes('Edit'));
});

it('stops instructing the shipped reviewer to write the thread artifact', () => {
  const reviewer = shippedDocument('agents', 'benchmark-reviewer');
  const prompts = Object.values(reviewer.stages as Record<string, { promptTemplate: string }>)
    .map(stage => stage.promptTemplate);

  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    // A prompt that asks for a tool the role no longer holds produces a refusal loop, not an audit.
    assert.equal(prompt.includes('you may write'), false, prompt);
    assert.equal(prompt.includes('Append'), false, prompt);
    // The verdict contract is the one thing that must survive verbatim: the transition engine
    // matches this literal, and the reviewer is told to make its audit the final message.
    assert.ok(prompt.includes(APPROVAL_MARKER), prompt);
    assert.ok(prompt.includes('final message'), prompt);
  }
  // The audit stage still reads the coder's handoff; only the write instruction is gone.
  assert.ok(reviewer.stages.audit.promptTemplate.includes('Read {{artifactPath}}'));
  assert.ok(reviewer.stages.finalAudit.promptTemplate.includes('{{artifactPath}}'));
});

it('stops declaring the shipped reviewer an agent that writes the thread artifact', () => {
  const reviewer = shippedDocument('agents', 'benchmark-reviewer');
  const systemPrompt = String(reviewer.systemPrompt);

  // The tool surface denies the write and the coordinator does the appending, so a system prompt
  // that still names the artifact as this role's output instructs an action it cannot perform.
  assert.equal(systemPrompt.includes('thread artifact'), false, systemPrompt);
  assert.equal(systemPrompt.includes('artifactPath'), false, systemPrompt);
  assert.ok(systemPrompt.includes('final message'), systemPrompt);
  // The read-only identity itself is untouched: it is what TA1 rests on.
  assert.ok(systemPrompt.includes('read-only implementation auditor'), systemPrompt);
  assert.ok(String(reviewer.directive).includes('without modifying project files'));
  // Same document, same run: the tool list is the one WL7 left, and this change did not widen it.
  assert.deepEqual(String(reviewer.tools).split(','), [
    'Bash', 'Read', 'Glob', 'Grep', 'TodoWrite', 'Skill',
  ]);
});

it('carries no write tool into the reviewer step the real loop builds', async () => {
  queueStep('coder done');
  queueStep(`audit passed ${APPROVAL_MARKER}`);
  const value = request('reviewer-surface');

  const result = await runBenchmarkThread(value);

  assert.equal(result.state, 'completed');
  assert.deepEqual(harness.stepOptions.map(step => step.slot), [
    'benchmark-coder', 'benchmark-reviewer',
  ]);
  const reviewer = harness.stepOptions[1];
  const tools = String(reviewer.tools).split(',');
  assert.equal(tools.includes('Write'), false, String(reviewer.tools));
  assert.equal(tools.includes('Edit'), false, String(reviewer.tools));
  assert.deepEqual(tools, ['Bash', 'Read', 'Glob', 'Grep', 'TodoWrite', 'Skill']);
  // Same seam, same run: the coder's surface still carries them, so the absence is the document's
  // and not something the step loop strips from every benchmark role.
  const coderTools = String(harness.stepOptions[0].tools).split(',');
  assert.ok(coderTools.includes('Write') && coderTools.includes('Edit'));
});

it('keeps the reviewer prompt free of a write instruction at the step it is rendered for', async () => {
  queueStep('coder done');
  queueStep(`audit passed ${APPROVAL_MARKER}`);
  const value = request('reviewer-prompt');

  const result = await runBenchmarkThread(value);

  assert.equal(result.state, 'completed');
  const rendered = harness.stepOptions[1].prompt;
  assert.equal(rendered.includes('you may write'), false, rendered);
  assert.equal(rendered.includes('Append'), false, rendered);
  assert.ok(rendered.includes(APPROVAL_MARKER));
  // The reviewer wrote nothing, yet its verdict is in the artifact: the coordinator appended it.
  const artifact = fs.readFileSync(result.artifactPath, 'utf8');
  assert.ok(artifact.includes(`audit passed ${APPROVAL_MARKER}`));
  assert.equal(artifact.split('\n').filter(line => line.startsWith('--- snapshot step ')).length, 1);
});
