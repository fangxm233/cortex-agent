import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/events/event-bus.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { PlanApprovals } from '../../src/orchestration/interactions/plan-approvals.js';
import { InteractionRecords } from '../../src/orchestration/interactions/interaction-records.js';
import { registerHookBridgeSubscribers } from '../../src/orchestration/routing/hook-bridge-subscribers.js';
import { initHookBridge, registerAskQuestion, registerPlanApproval } from '../../src/orchestration/routing/hook-bridge.js';
import { answerQuestion } from '../../src/orchestration/interactions/answer-question.js';
import { respondToPlan } from '../../src/orchestration/interactions/plan-response.js';
import {
  installTeamDelivery, notifyLeadOfWorkerRequest, onWorkerTurnCompleted, REPORT_MAX_CHARS,
  type TeamDeliveryDeps,
} from '../../src/orchestration/team-delivery.js';
import { _resetTeamState, describeTeam, type WorkerView } from '../../src/orchestration/team-state.js';

const LEAD = { sessionId: 'lead', name: 'cortex-lead', channel: 'web:lead', origin: 'direct' };
const WORKER = { sessionId: 'worker', name: 'cortex-w', channel: 'web:worker', origin: 'direct', teamLeadId: 'lead', workerName: 'alpha' };

function view(extra: Partial<WorkerView> = {}): WorkerView {
  return {
    name: 'alpha', sessionId: 'worker', channel: 'web:worker', status: 'idle', waitingOn: [], brief: null,
    lastReport: null, contextPercent: 42, userTouched: false, retired: false, ...extra,
  };
}

function deps(opts: { enabled?: boolean; lead?: boolean } = {}) {
  const delivered: Array<{ channel: string; text: string; origin: string }> = [];
  const sessions = new Map<string, any>([['worker', WORKER], ...(opts.lead === false ? [] : [['lead', LEAD]] as any)]);
  const d: TeamDeliveryDeps = {
    enabled: () => opts.enabled ?? true,
    getSession: async (id) => sessions.get(id) ?? null,
    deliver: (o) => { delivered.push(o as any); },
    describe: async () => view(),
    now: () => 1_000,
  };
  return { d, delivered };
}

beforeEach(() => _resetTeamState());

const completed = (extra: Record<string, unknown> = {}) => ({
  sessionId: 'worker', status: 'completed' as const, finalOutput: 'Done. Output in out/report.md', trigger: 'team-lead', ...extra,
});

test('a lead-started worker turn is reported to the lead with a status line and the final reply', async () => {
  const { d, delivered } = deps();
  await onWorkerTurnCompleted(completed(), d);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'web:lead');
  assert.equal(delivered[0].origin, 'worker-result');
  assert.equal(delivered[0].text, '[Worker alpha · completed]\nstatus idle · ctx 42%\n\nDone. Output in out/report.md');
});

test('turns started by anything but the human are reported, including failures and stops', async () => {
  for (const [trigger, status] of [['agent-result', 'completed'], ['external-signal', 'failed'], ['ask-user-answer', 'stopped']] as const) {
    const { d, delivered } = deps();
    await onWorkerTurnCompleted(completed({ trigger, status, finalOutput: status === 'stopped' ? '' : 'x' }), d);
    assert.equal(delivered.length, 1, trigger);
    assert.match(delivered[0].text, new RegExp(`^\\[Worker alpha · ${status}\\]`));
  }
  const { d, delivered } = deps();
  await onWorkerTurnCompleted(completed({ status: 'stopped', finalOutput: '' }), d);
  assert.match(delivered[0].text, /stopped before a final reply/);
});

test('a turn the human started in the worker is not reported, only flagged on the roster', async () => {
  const { d, delivered } = deps();
  await onWorkerTurnCompleted(completed({ trigger: 'web-user' }), d);
  assert.equal(delivered.length, 0);
  const team = await describeTeam('lead', {
    isRunning: () => false, isQueued: () => false, pendingInteractions: () => [], history: async () => null, now: () => 0,
  }, async () => [WORKER as any]);
  assert.equal(team[0].userTouched, true);
  assert.equal(team[0].lastReport, null, 'the human turn is not the lead’s report');
});

test('nothing is reported with team mode off, without a lead, or for a non-worker', async () => {
  for (const opts of [{ enabled: false }, { lead: false }]) {
    const { d, delivered } = deps(opts);
    await onWorkerTurnCompleted(completed(), d);
    assert.equal(delivered.length, 0);
  }
  const { d, delivered } = deps();
  await onWorkerTurnCompleted(completed({ sessionId: 'lead' }), d);
  assert.equal(delivered.length, 0);
});

test('a long report is capped with a pointer to the full text, which worker_list keeps', async () => {
  const { d, delivered } = deps();
  await onWorkerTurnCompleted(completed({ finalOutput: 'y'.repeat(REPORT_MAX_CHARS + 50) }), d);
  assert.match(delivered[0].text, /Truncated\. Call worker_list\("alpha"\)/);
  const team = await describeTeam('lead', {
    isRunning: () => false, isQueued: () => false, pendingInteractions: () => [], history: async () => null, now: () => 0,
  }, async () => [WORKER as any]);
  assert.equal(team[0].lastReport!.text.length, REPORT_MAX_CHARS + 50);
});

test('installTeamDelivery reports from the session.turn.completed event', async () => {
  const bus = new EventBus();
  const { d, delivered } = deps();
  installTeamDelivery(bus, d);
  bus.publish({ type: 'session.turn.completed', channel: 'web:worker', ...completed() });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(delivered.length, 1);
});

// ── interaction routing ─────────────────────────────────────────────────────

function routing(opts: { enabled?: boolean } = {}) {
  const bus = new EventBus();
  initHookBridge(bus);
  const planApprovals = new PlanApprovals(bus);
  const interactions = new InteractionRecords();
  const resolvedVia: string[] = [];
  interactions.init({
    history: {
      appendInteractionCreated: async () => {},
      appendInteractionResolved: async (_s: string, a: any) => { resolvedVia.push(a.resolvedVia); },
    } as any,
    bus,
  });
  const { d, delivered } = deps(opts);
  registerHookBridgeSubscribers(bus, new MockAdapter() as any, planApprovals, interactions, () => {},
    (request) => notifyLeadOfWorkerRequest(request, d));
  return { bus, planApprovals, interactions, delivered, resolvedVia };
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const QUESTIONS = [{ question: 'Which DB?', header: 'DB', options: [{ label: 'pg' }, { label: 'sqlite' }], multiSelect: false }];

test('a worker question creates its own card and a lead notice; the lead answer resolves it', async () => {
  const r = routing();
  const answered = registerAskQuestion('req-q', 'web:worker', 'worker', QUESTIONS);
  await flush();
  assert.equal(r.interactions.isPending('req-q'), true, 'the worker card exists');
  assert.equal(r.delivered.length, 1);
  assert.equal(r.delivered[0].origin, 'worker-question');
  assert.equal(r.delivered[0].channel, 'web:lead');
  assert.match(r.delivered[0].text, /^\[Worker alpha · question · request_id=req-q · blocking\]/);
  assert.match(r.delivered[0].text, /Q1: Which DB\?\n {3}Options: pg \| sqlite/);
  assert.match(r.delivered[0].text, /worker_answer\(request_id="req-q"/);

  const outcome = answerQuestion('req-q', { 'Which DB?': 'pg' }, 'agent', {
    interactionRecords: r.interactions,
    getGroup: (await import('../../src/orchestration/interactions/ask-user-question.js')).getGroupByHookRequestId,
    tryResolveHook: (await import('../../src/orchestration/interactions/ask-user-question.js')).tryResolveHook,
    resolveRequest: (await import('../../src/orchestration/routing/hook-bridge.js')).resolveRequest,
  });
  assert.equal(outcome, 'resolved');
  assert.deepEqual((await answered).answers, { 'Which DB?': 'pg' });
  await flush();
  assert.deepEqual(r.resolvedVia, ['agent']);
});

test('when the human answers on the worker card first, the lead gets already-resolved', async () => {
  const r = routing();
  const ask = await import('../../src/orchestration/interactions/ask-user-question.js');
  const hb = await import('../../src/orchestration/routing/hook-bridge.js');
  const answerDeps = { interactionRecords: r.interactions, getGroup: ask.getGroupByHookRequestId, tryResolveHook: ask.tryResolveHook, resolveRequest: hb.resolveRequest };
  void registerAskQuestion('req-race', 'web:worker', 'worker', QUESTIONS);
  await flush();
  assert.equal(answerQuestion('req-race', { 'Which DB?': 'sqlite' }, 'web', answerDeps), 'resolved');
  await flush();
  assert.equal(answerQuestion('req-race', { 'Which DB?': 'pg' }, 'agent', answerDeps), 'already-resolved');
});

test('a worker plan (or commission contract) reaches the lead, which can approve or reject it', async () => {
  const r = routing();
  const approval = registerPlanApproval('req-plan', 'web:worker', 'worker', '# Plan\n1. step', { plan_file_path: '/p/plan.md' });
  await flush();
  assert.match(r.delivered[0].text, /^\[Worker alpha · plan approval · request_id=req-plan · blocking\]/);
  assert.match(r.delivered[0].text, /Plan file: \/p\/plan\.md\n# Plan\n1\. step/);
  assert.equal(respondToPlan({ planApprovals: r.planApprovals, interactionRecords: r.interactions }, 'req-plan', true, '', 'agent'), 'resolved');
  assert.equal((await approval).approved, true, 'the blocked submit sees the approval (commission submit finalizes on it)');

  const rejected = registerPlanApproval('req-plan-2', 'web:worker', 'worker', 'plan', {});
  await flush();
  assert.equal(respondToPlan({ planApprovals: r.planApprovals, interactionRecords: r.interactions }, 'req-plan-2', false, 'smaller', 'agent'), 'resolved');
  assert.deepEqual(await rejected, { approved: false, reason: 'smaller' });
});

test('with team mode off a worker request stays on the worker card only', async () => {
  const r = routing({ enabled: false });
  void registerAskQuestion('req-off', 'web:worker', 'worker', QUESTIONS);
  await flush();
  assert.equal(r.interactions.isPending('req-off'), true);
  assert.equal(r.delivered.length, 0);
});
