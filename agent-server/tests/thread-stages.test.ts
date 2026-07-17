// input:  node:test, threadStore, thread-manager pure helpers
// output: Stage abstraction parseTarget/resolveStage/buildStepPrompt tests
// pos:    Per-agent multi-stage layer unit regression test
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, CONTEXT_DIR } from '../src/core/utils.js';
import { threadStore } from '../src/store/thread-repo.js';
import {
  parseTarget,
  resolveStageName,
  formatEndpoint,
  pickStepTemplate,
  buildStepPrompt,
  THREAD_PROTOCOL_PREAMBLE,
} from '../src/domain/threads/index.js';
import type { AgentSlotConfig, ThreadRecord, AgentDefinition } from '../src/core/types/thread-types.js';

// --- threads.json backup / restore so tests do not pollute production state ---

const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
let threadsBackup: string | null = null;
let threadsBackupExisted = false;
const testThreadIds = new Set<string>();

beforeAll(() => {
  try {
    threadsBackup = fs.readFileSync(THREADS_FILE, 'utf8');
    threadsBackupExisted = true;
  } catch {
    threadsBackup = null;
    threadsBackupExisted = false;
  }
});

afterAll(async () => {
  if (threadsBackupExisted && threadsBackup != null) {
    fs.writeFileSync(THREADS_FILE, threadsBackup);
  } else {
    try { fs.unlinkSync(THREADS_FILE); } catch {}
  }
  for (const id of testThreadIds) await threadStore.delete(id);
  await threadStore.flush();
});

process.on('exit', () => {
  if (threadsBackupExisted && threadsBackup != null) {
    try { fs.writeFileSync(THREADS_FILE, threadsBackup); } catch {}
  }
});

// --- Test helpers ---

function makeSlotConfig(overrides: Partial<AgentSlotConfig> = {}): AgentSlotConfig {
  return {
    slotId: 'coder',
    profile: '__active__',
    persistSession: true,
    directive: 'coder-directive',
    promptTemplate: 'LEGACY template: {{input}}',
    stages: {
      plan: { promptTemplate: 'PLAN stage: read {{artifactPath}}' },
      implement: { continuesSession: true, promptTemplate: 'IMPLEMENT stage: per review' },
      retry: { continuesSession: true, promptTemplate: 'RETRY stage: address blockers' },
    },
    entryStage: 'plan',
    ...overrides,
  };
}

function makeAgentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'coder',
    profile: '__active__',
    persistSession: true,
    directive: 'coder-directive',
    promptTemplate: 'LEGACY',
    stages: {
      plan: { promptTemplate: 'PLAN' },
      implement: { continuesSession: true, promptTemplate: 'IMPL' },
    },
    entryStage: 'plan',
    ...overrides,
  };
}

function uniqueThreadId(prefix: string): string {
  return `thr_test-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeThreadRecord(opts: {
  id: string;
  slotId: string;
  sessionId?: string | null;
  persistSession?: boolean;
  artifactPath?: string;
  templateName?: string | null;
}): ThreadRecord {
  const now = new Date().toISOString();
  const persistSession = opts.persistSession ?? true;
  return {
    id: opts.id,
    templateName: opts.templateName ?? 'coder-review',
    status: 'running',
    channel: 'C-stage-test',
    projectId: 'general',
    platformThreadId: null,
    userMessage: 'the-user-input',
    userMessageTs: 'ts-1',
    workspacePath: opts.artifactPath ? path.dirname(opts.artifactPath) : '',
    artifactPath: opts.artifactPath ?? '',
    agents: {
      [opts.slotId]: {
        slotId: opts.slotId,
        profile: '__active__',
        sessionId: opts.sessionId ?? null,
        sessionName: null,
        status: 'idle',
        lastOutput: null,
        persistSession,
      },
    },
    activeAgent: opts.slotId,
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

// ==============================
// A. parseTarget
// ==============================

test('parseTarget splits `"agent:stage"` on the first colon', () => {
  assert.deepEqual(parseTarget('coder:plan'), { agent: 'coder', stage: 'plan' });
});

test('parseTarget returns stage=null when endpoint has no colon', () => {
  assert.deepEqual(parseTarget('coder'), { agent: 'coder', stage: null });
});

test('parseTarget treats trailing empty stage as null (agent:)', () => {
  assert.deepEqual(parseTarget('coder:'), { agent: 'coder', stage: null });
});

test('parseTarget keeps only the first segment as agent and preserves remainder as stage', () => {
  // Defensive: stages with further colons still get captured; no agent should use colons,
  // but this guarantees backward-compatible parsing if a stage name ever contains one.
  assert.deepEqual(parseTarget('coder:plan:v2'), { agent: 'coder', stage: 'plan:v2' });
});

// ==============================
// B. resolveStageName
// ==============================

test('resolveStageName returns null when agent has no stages map', () => {
  const def = makeAgentDef({ stages: undefined, entryStage: undefined });
  assert.equal(resolveStageName(def, null), null);
  assert.equal(resolveStageName(def, 'plan'), null);
});

test('resolveStageName returns the explicit stage when it exists on the agent', () => {
  const def = makeAgentDef();
  assert.equal(resolveStageName(def, 'implement'), 'implement');
});

test('resolveStageName falls back to entryStage when explicit is null or unknown', () => {
  const def = makeAgentDef();
  assert.equal(resolveStageName(def, null), 'plan');
  assert.equal(resolveStageName(def, 'nonexistent-stage'), 'plan');
});

test('resolveStageName falls back to the first declared stage when entryStage is unset', () => {
  const def = makeAgentDef({ entryStage: undefined });
  // First key of `stages` in the order it was declared.
  assert.equal(resolveStageName(def, null), 'plan');
});

test('resolveStageName returns null for null agent (defensive)', () => {
  assert.equal(resolveStageName(null, 'anything'), null);
});

// ==============================
// C. formatEndpoint
// ==============================

test('formatEndpoint joins agent + stage with colon', () => {
  assert.equal(formatEndpoint('coder', 'plan'), 'coder:plan');
});

test('formatEndpoint renders bare agent name when stage is null', () => {
  assert.equal(formatEndpoint('coder', null), 'coder');
});

// ==============================
// D. pickStepTemplate
// ==============================

test('pickStepTemplate returns stage-specific template when stage is set and exists', () => {
  const cfg = makeSlotConfig();
  const picked = pickStepTemplate(cfg, 'implement');
  assert.equal(picked.template, 'IMPLEMENT stage: per review');
  assert.equal(picked.continuesSession, true);
});

test('pickStepTemplate returns legacy promptTemplate when stage is null', () => {
  const cfg = makeSlotConfig();
  const picked = pickStepTemplate(cfg, null);
  assert.equal(picked.template, 'LEGACY template: {{input}}');
  assert.equal(picked.continuesSession, false);
});

test('pickStepTemplate falls back to legacy promptTemplate when stage is unknown', () => {
  const cfg = makeSlotConfig();
  const picked = pickStepTemplate(cfg, 'no-such-stage');
  assert.equal(picked.template, 'LEGACY template: {{input}}');
  assert.equal(picked.continuesSession, false);
});

test('pickStepTemplate falls back to `{{input}}` when neither stage nor promptTemplate is set', () => {
  const cfg = makeSlotConfig({ promptTemplate: undefined, stages: undefined, entryStage: undefined });
  assert.equal(pickStepTemplate(cfg, null).template, '{{input}}');
});

// ==============================
// E. buildStepPrompt — stage-aware
// ==============================

test('buildStepPrompt selects stages[plan].promptTemplate when stage="plan" and no session exists', () => {
  const id = uniqueThreadId('plan');
  const thread = makeThreadRecord({ id, slotId: 'coder', sessionId: null, artifactPath: '/tmp/fake/artifact.md' });
  registerTestThread(thread);
  const cfg = makeSlotConfig();

  const prompt = buildStepPrompt(id, cfg, 'plan');
  assert.match(prompt, /PLAN stage: read \/tmp\/fake\/artifact\.md/);
  // First trigger (no sessionId yet) → directive + preamble prepended.
  assert.match(prompt, /coder-directive/);
  assert.match(prompt, /Cortex Thread Protocol/);
});

test('buildStepPrompt stage=implement with continuesSession=true + live session → incremental (no directive/preamble)', () => {
  const id = uniqueThreadId('impl');
  const thread = makeThreadRecord({ id, slotId: 'coder', sessionId: 'live-session-abc', artifactPath: '/tmp/fake/artifact.md' });
  registerTestThread(thread);
  const cfg = makeSlotConfig();

  const prompt = buildStepPrompt(id, cfg, 'implement');
  // Exactly the stage template, nothing else.
  assert.equal(prompt, 'IMPLEMENT stage: per review');
  assert.doesNotMatch(prompt, /coder-directive/);
  assert.doesNotMatch(prompt, /Cortex Thread Protocol/);
});

test('buildStepPrompt stage=implement with continuesSession=true but NO session → full bootstrap fallback', () => {
  const id = uniqueThreadId('impl-fresh');
  const thread = makeThreadRecord({ id, slotId: 'coder', sessionId: null, artifactPath: '/tmp/fake/artifact.md' });
  registerTestThread(thread);
  const cfg = makeSlotConfig();

  const prompt = buildStepPrompt(id, cfg, 'implement');
  // Session is not resumable → directive + preamble prepended, stage template at the end.
  assert.match(prompt, /coder-directive/);
  assert.match(prompt, new RegExp(THREAD_PROTOCOL_PREAMBLE.split('\n')[0].replace(/[[\]]/g, m => '\\' + m)));
  assert.match(prompt, /IMPLEMENT stage: per review/);
});

test('buildStepPrompt stage=plan (continuesSession=false) + live session → skip directive+preamble (resume behaviour preserved)', () => {
  // This matches the legacy invariant: any persistSession agent with a live session skips
  // directive + preamble on resume, independent of the stage's continuesSession flag.
  const id = uniqueThreadId('plan-resume');
  const thread = makeThreadRecord({ id, slotId: 'coder', sessionId: 'live-session-xyz', artifactPath: '/tmp/fake/artifact.md' });
  registerTestThread(thread);
  const cfg = makeSlotConfig();

  const prompt = buildStepPrompt(id, cfg, 'plan');
  assert.match(prompt, /PLAN stage: read \/tmp\/fake\/artifact\.md/);
  assert.doesNotMatch(prompt, /coder-directive/);
  assert.doesNotMatch(prompt, /Cortex Thread Protocol/);
});

test('buildStepPrompt stage=null (legacy single-template agent) unchanged behaviour', () => {
  const id = uniqueThreadId('legacy');
  const thread = makeThreadRecord({ id, slotId: 'coder', sessionId: null, artifactPath: '/tmp/fake/artifact.md' });
  registerTestThread(thread);
  // Agent with no stages — prompt should come from promptTemplate verbatim.
  const cfg = makeSlotConfig({ stages: undefined, entryStage: undefined });

  const prompt = buildStepPrompt(id, cfg, null);
  assert.match(prompt, /LEGACY template: the-user-input/);
  assert.match(prompt, /coder-directive/);
  assert.match(prompt, /Cortex Thread Protocol/);
});

test('buildStepPrompt never injects [User Context], even for a direct-template thread with USER.md present', () => {
  // Thread steps must NOT carry the user profile — only thread-free conversation turns do.
  // Regression for the user-context split: a `direct` template previously leaked USER.md into
  // every thread step via loadUserContext's template allow-list.
  const userDir = path.join(CONTEXT_DIR, 'user');
  const userMd = path.join(userDir, 'USER.md');
  let restore: string | null = null;
  try { restore = fs.readFileSync(userMd, 'utf8'); } catch {}
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(userMd, '# User Profile\n- Name: Leak Canary\n');
  try {
    const id = uniqueThreadId('direct-no-userctx');
    const thread = makeThreadRecord({
      id, slotId: 'coder', sessionId: null, artifactPath: '/tmp/fake/artifact.md',
      templateName: 'direct',
    });
    registerTestThread(thread);
    const cfg = makeSlotConfig();

    const prompt = buildStepPrompt(id, cfg, 'plan');
    assert.doesNotMatch(prompt, /\[User Context\]/);
    assert.doesNotMatch(prompt, /Leak Canary/);
  } finally {
    if (restore != null) fs.writeFileSync(userMd, restore);
    else { try { fs.unlinkSync(userMd); } catch {} }
  }
});

test('buildStepPrompt stage=implement + ad-hoc thread (templateName=null) + incremental mode suppresses auto previousOutput injection', () => {
  // Ad-hoc path normally auto-prepends "Below is the output from the previous agent:" when the template doesn't
  // contain `{{previousOutput}}`. Incremental mode (continuesSession + live session) must skip this,
  // since the conversation history already carries that context.
  const id = uniqueThreadId('adhoc-inc');
  const thread = makeThreadRecord({
    id, slotId: 'coder', sessionId: 'live-session-2', artifactPath: '/tmp/fake/artifact.md',
    templateName: null,
  });
  // Seed a prior step whose output would otherwise be injected.
  thread.steps = [{
    stepIndex: 0, agentSlotId: 'coder', stage: 'plan',
    executionId: null, sessionId: 'live-session-2', sessionName: null,
    input: '', output: 'prior-step-output-xyz',
    costUsd: 0, numTurns: 1, durationS: 1, startedAt: null, endedAt: null,
  }];
  registerTestThread(thread);
  const cfg = makeSlotConfig();

  const prompt = buildStepPrompt(id, cfg, 'implement');
  assert.equal(prompt, 'IMPLEMENT stage: per review');
  assert.doesNotMatch(prompt, /prior-step-output-xyz/);
});
