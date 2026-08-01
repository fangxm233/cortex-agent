// input:  node:test, domain/threads state-machine + utils, fake job-registry bus
// output: coverage for beginStepSession (track-id minting / legacy migration / resume target /
//         interrupted-session consumption),
//         recordStepResult backendSessionId decoupling, resolveTargetResumeId, and the
//         thread lifecycle EventBus publishes (created / step.started / step.finished /
//         completed / failed / cancelled→failed)
// pos:    verifies a RUNNING thread step carries a queryable sessionId from step start
//         (web UI live transcript: snapshot + delta) and backend resume ids stay decoupled
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { threadStore } from '../../src/store/thread-repo.js';
import { DEFAULTS_DIR, CONFIG_DIR } from '../../src/core/utils.js';
import { ctx as jobCtx } from '../../src/domain/scheduling/job-registry.js';
import {
  createThread,
  loadConfig,
  mergeThreadTemplates,
  addAgentToThread,
  beginStepSession,
  listAgents,
  recordStepResult,
  completeThread,
  failThread,
  cancelThread,
} from '../../src/domain/threads/index.js';
import { resolveTargetResumeId } from '../../src/domain/threads/utils.js';
import type { AgentSlot, AgentStep, ThreadRecord } from '../../src/core/types/thread-types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let events: any[] = [];

beforeAll(() => {
  // The per-file temp CORTEX_HOME has no thread-templates when run standalone (test:file):
  // seed the shipped defaults so the coder-review template resolves, then load.
  mergeThreadTemplates(
    path.join(DEFAULTS_DIR, 'config', 'thread-templates'),
    path.join(CONFIG_DIR, 'thread-templates'),
  );
  loadConfig();
});

afterEach(() => { jobCtx.bus = null; });

function armBus(): void {
  events = [];
  jobCtx.bus = { publish: (e: any) => { events.push(e); } } as any;
}

function freshThread(): ThreadRecord {
  const t = createThread('test-channel', {
    templateName: 'coder-review',
    userMessage: 'implement X',
    userMessageTs: 'ts-0',
  });
  return t;
}

function slotOf(threadId: string, slotId: string): AgentSlot {
  return threadStore.get(threadId)!.agents[slotId]!;
}

// ── beginStepSession ────────────────────────────────────────────────────────

test('beginStepSession mints a persisted track id for a fresh persist slot; resume target is null', async () => {
  armBus();
  const t = freshThread();
  const { trackSessionId, resumeSessionId } = await beginStepSession(t.id, 'coder', 'plan');

  assert.match(trackSessionId, UUID_RE, 'track id is a minted uuid');
  assert.equal(resumeSessionId, null, 'fresh slot has no backend session to resume');
  const slot = slotOf(t.id, 'coder');
  assert.equal(slot.sessionId, trackSessionId, 'track id persisted on the slot (threads.json)');
  assert.equal(slot.backendSessionId, null, 'backendSessionId field initialized (new semantics marker)');
});

test('beginStepSession keeps a legacy slot sessionId as BOTH track key and resume target (migration)', async () => {
  const t = freshThread();
  await threadStore.mutate(t.id, (th) => {
    const s = th.agents['coder']!;
    s.sessionId = 'backend-legacy-1';
    delete (s as any).backendSessionId;
  });
  const { trackSessionId, resumeSessionId } = await beginStepSession(t.id, 'coder', 'plan');
  assert.equal(trackSessionId, 'backend-legacy-1', 'history continuity: legacy id stays the transcript key');
  assert.equal(resumeSessionId, 'backend-legacy-1', 'legacy id was the backend id — still the resume target');
  assert.equal(slotOf(t.id, 'coder').backendSessionId, 'backend-legacy-1');
});

test('beginStepSession resumes from backendSessionId on a settled persist slot, track id unchanged', async () => {
  const t = freshThread();
  await threadStore.mutate(t.id, (th) => {
    const s = th.agents['coder']!;
    s.sessionId = 'track-stable';
    s.backendSessionId = 'backend-b2';
  });
  const { trackSessionId, resumeSessionId } = await beginStepSession(t.id, 'coder', 'implement');
  assert.equal(trackSessionId, 'track-stable');
  assert.equal(resumeSessionId, 'backend-b2');
});

test('beginStepSession mints a NEW track id per step for a non-persist slot, never resumes', async () => {
  const t = freshThread();
  await threadStore.mutate(t.id, (th) => {
    const s = th.agents['coder']!;
    s.persistSession = false;
    s.backendSessionId = 'backend-old';
  });
  const first = await beginStepSession(t.id, 'coder', 'plan');
  const second = await beginStepSession(t.id, 'coder', 'plan');
  assert.match(first.trackSessionId, UUID_RE);
  assert.match(second.trackSessionId, UUID_RE);
  assert.notEqual(first.trackSessionId, second.trackSessionId, 'fresh conversation per step');
  assert.equal(first.resumeSessionId, null);
  assert.equal(second.resumeSessionId, null);
});

test('beginStepSession consumes interruptedBackendSessionId once, keeping the track id (non-persist too)', async () => {
  const t = freshThread();
  await threadStore.mutate(t.id, (th) => {
    const s = th.agents['coder']!;
    s.persistSession = false;
    s.sessionId = 'track-interrupted';
    s.interruptedBackendSessionId = 'backend-int';
  });

  const first = await beginStepSession(t.id, 'coder', 'plan');
  assert.equal(first.trackSessionId, 'track-interrupted', 'rerun continues the same UI transcript');
  assert.equal(first.resumeSessionId, 'backend-int', 'rerun resumes the interrupted backend session');
  assert.equal(slotOf(t.id, 'coder').interruptedBackendSessionId, null, 'one-shot: consumed');

  const second = await beginStepSession(t.id, 'coder', 'plan');
  assert.notEqual(second.trackSessionId, 'track-interrupted', 'non-persist slot back to fresh per-step ids');
  assert.equal(second.resumeSessionId, null);
});

test('addAgentToThread re-upsert preserves a pending interruptedBackendSessionId', async () => {
  const agentName = listAgents()[0].name;
  const t = createThread('test-channel', { agentName, userMessage: 'x', userMessageTs: 'ts' });
  await threadStore.mutate(t.id, (th) => {
    th.agents[agentName]!.interruptedBackendSessionId = 'backend-pending';
  });

  await addAgentToThread(t.id, agentName);

  assert.equal(slotOf(t.id, agentName).interruptedBackendSessionId, 'backend-pending');
});

test('beginStepSession publishes thread.step.started with the slot:stage step label', async () => {
  armBus();
  const t = freshThread();
  await beginStepSession(t.id, 'coder', 'plan');
  const ev = events.find((e) => e.type === 'thread.step.started');
  assert.ok(ev, 'thread.step.started published');
  assert.equal(ev.threadId, t.id);
  assert.equal(ev.step, 'coder:plan');
});

// ── recordStepResult: sessionId (track) / backendSessionId decoupling ──────

test('recordStepResult stores track + backend ids on the step and updates the persist slot backend id only', async () => {
  armBus();
  const t = freshThread();
  const { trackSessionId } = await beginStepSession(t.id, 'coder', 'plan');
  await recordStepResult(t.id, 'coder', {
    sessionId: trackSessionId,
    backendSessionId: 'backend-real-1',
    sessionName: 'cortex-aaaa',
    executionId: null,
    input: 'p',
    startedAt: new Date().toISOString(),
    output: 'step output text',
    costUsd: 0.1,
    numTurns: 3,
    durationS: 5,
    stage: 'plan',
  });

  const th = threadStore.get(t.id)!;
  const step = th.steps[0] as AgentStep;
  assert.equal(step.sessionId, trackSessionId, 'step keyed by the track id (UI transcript key)');
  assert.equal(step.backendSessionId, 'backend-real-1', 'backend id carried for resume');
  const slot = th.agents['coder']!;
  assert.equal(slot.sessionId, trackSessionId, 'slot track id unchanged at settle');
  assert.equal(slot.backendSessionId, 'backend-real-1', 'slot backend resume target updated');
});

test('recordStepResult publishes thread.step.finished with a truncated result', async () => {
  armBus();
  const t = freshThread();
  await beginStepSession(t.id, 'coder', 'plan');
  await recordStepResult(t.id, 'coder', {
    sessionId: 'x', sessionName: null, executionId: null, input: '',
    startedAt: null, output: 'Z'.repeat(500), costUsd: null, numTurns: null, durationS: null, stage: 'plan',
  });
  const ev = events.find((e) => e.type === 'thread.step.finished');
  assert.ok(ev, 'thread.step.finished published');
  assert.equal(ev.threadId, t.id);
  assert.equal(ev.step, 'coder:plan');
  assert.ok(ev.result.length <= 200, 'result truncated');
});

// ── thread lifecycle events ────────────────────────────────────────────────

test('createThread publishes thread.created', () => {
  armBus();
  const t = freshThread();
  const ev = events.find((e) => e.type === 'thread.created');
  assert.ok(ev, 'thread.created published');
  assert.equal(ev.threadId, t.id);
  assert.equal(ev.templateName, 'coder-review');
});

test('completeThread / failThread / cancelThread publish terminal events', async () => {
  const t1 = freshThread();
  const t2 = freshThread();
  const t3 = freshThread();
  armBus();
  await completeThread(t1.id);
  await failThread(t2.id, 'boom');
  await cancelThread(t3.id);

  const completed = events.find((e) => e.type === 'thread.completed');
  assert.ok(completed && completed.threadId === t1.id, 'thread.completed published');
  const failed = events.find((e) => e.type === 'thread.failed' && e.threadId === t2.id);
  assert.ok(failed && failed.error === 'boom', 'thread.failed published with error');
  const cancelled = events.find((e) => e.type === 'thread.failed' && e.threadId === t3.id);
  assert.ok(cancelled && cancelled.error === 'cancelled', 'cancel maps to thread.failed(cancelled) for UI refetch');
});

// ── resolveTargetResumeId (hook-runner resume target, pure) ────────────────

function mkSlot(over: Partial<AgentSlot>): AgentSlot {
  return {
    slotId: 'coder', profile: 'p', sessionId: null, sessionName: null,
    status: 'idle', lastOutput: null, persistSession: true, ...over,
  } as AgentSlot;
}

function mkStep(over: Partial<AgentStep>): AgentStep {
  return {
    stepIndex: 0, agentSlotId: 'coder', stage: null, executionId: null,
    sessionId: null, sessionName: null, input: '', output: null,
    costUsd: null, numTurns: null, durationS: null, startedAt: null,
    endedAt: new Date().toISOString(), ...over,
  } as AgentStep;
}

test('resolveTargetResumeId prefers the slot backendSessionId, never returns a track id', () => {
  assert.equal(resolveTargetResumeId(mkSlot({ sessionId: 'track-x', backendSessionId: 'b1' }), []), 'b1');
  // new slot pre-settle: backend explicitly null → no resume target (track id must NOT leak)
  assert.equal(resolveTargetResumeId(mkSlot({ sessionId: 'track-x', backendSessionId: null }), []), null);
});

test('resolveTargetResumeId falls back to legacy slot sessionId when backend field is absent', () => {
  const legacy = mkSlot({ sessionId: 'backend-legacy' });
  delete (legacy as any).backendSessionId;
  assert.equal(resolveTargetResumeId(legacy, []), 'backend-legacy');
});

test('resolveTargetResumeId falls back to the most recent step of the slot (new + legacy forms)', () => {
  const slot = mkSlot({ sessionId: null, backendSessionId: null });
  const newStep = mkStep({ sessionId: 'track-y', backendSessionId: 'b3' });
  assert.equal(resolveTargetResumeId(slot, [newStep]), 'b3', 'new-form step: backend id, not track id');
  const legacyStep = mkStep({ sessionId: 's-old' });
  delete (legacyStep as any).backendSessionId;
  assert.equal(resolveTargetResumeId(slot, [legacyStep]), 's-old', 'legacy step: sessionId was the backend id');
  assert.equal(resolveTargetResumeId(slot, []), null, 'nothing known → fresh');
});
