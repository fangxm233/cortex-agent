import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventBus } from '../../src/events/event-bus.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { PlanApprovals } from '../../src/orchestration/interactions/plan-approvals.js';
import { InteractionRecords } from '../../src/orchestration/interactions/interaction-records.js';
import { registerHookBridgeSubscribers } from '../../src/orchestration/routing/hook-bridge-subscribers.js';
import { initHookBridge, registerAskQuestion, registerPlanApproval } from '../../src/orchestration/routing/hook-bridge.js';
import { answerQuestion } from '../../src/orchestration/interactions/answer-question.js';
import { respondToPlan } from '../../src/orchestration/interactions/plan-response.js';
import {
  flushTeamOutbox, installTeamDelivery, notifyLeadOfWorkerRequest, onWorkerTurnCompleted, REPORT_MAX_CHARS,
  type TeamDeliveryDeps,
} from '../../src/orchestration/team-delivery.js';
import {
  _resetTeamState, describeTeam, markTurnRoutine, takeRoutineMark, type WorkerView,
} from '../../src/orchestration/team-state.js';
import { formatUnreadDigest, inboxLine, UNREAD_DIGEST_HEADER } from '../../src/orchestration/team-inbox.js';
import { TeamOutboxRepo } from '../../src/store/team-outbox-repo.js';
import { TeamInboxRepo } from '../../src/store/team-inbox-repo.js';

const LEAD = { sessionId: 'lead', channel: 'web:lead', origin: 'direct' };
const WORKER = { sessionId: 'worker', channel: 'web:worker', origin: 'direct', teamLeadId: 'lead', workerName: 'alpha' };

function view(extra: Partial<WorkerView> = {}): WorkerView {
  return {
    name: 'alpha', sessionId: 'worker', channel: 'web:worker', status: 'idle', waitingOn: [], waitpoints: 0, brief: null,
    lastReport: null, userTouched: false, retired: false, ...extra,
  };
}

let outboxSeq = 0;

function deps(opts: { enabled?: boolean; lead?: boolean; outbox?: TeamOutboxRepo } = {}) {
  const delivered: Array<{ channel: string; text: string; origin: string }> = [];
  const sessions = new Map<string, any>([['worker', WORKER], ...(opts.lead === false ? [] : [['lead', LEAD]] as any)]);
  /** Busy count, as the tracker keeps it; `idleAt` records each 1→0 transition (the daemon's cue). */
  const busy = { count: 0, idleAt: [] as number[] };
  /** When true, delivery is refused the way the runner refuses under a rebuild hold. */
  const hold = { on: false };
  const progress: Array<{ lead: string; text: string; worker: { name: string; sessionId: string }; ts: string }> = [];
  /** Whether a backgrounded agent outlives the worker's turn; what the report's status line was given. */
  const background = { on: false, described: [] as Array<boolean | undefined> };
  const inbox = new TeamInboxRepo(path.join(process.env.CORTEX_HOME!, 'data', `team-inbox-${++outboxSeq}.json`));
  let retries = 0;
  const d: TeamDeliveryDeps = {
    enabled: () => opts.enabled ?? true,
    getSession: async (id) => sessions.get(id) ?? null,
    deliver: async (o) => {
      if (hold.on) {
        if (o.onRebuildHold) await o.onRebuildHold();
        return;
      }
      delivered.push({ channel: o.channel, text: o.text, origin: o.origin });
    },
    describe: async (_worker, running) => {
      background.described.push(running);
      return view(running ? { status: 'running' } : {});
    },
    now: () => 1_000,
    track: (delta) => {
      busy.count += delta;
      if (busy.count === 0 && delta < 0) busy.idleAt.push(delivered.length);
    },
    outbox: opts.outbox ?? new TeamOutboxRepo(path.join(process.env.CORTEX_HOME!, 'data', `team-outbox-${++outboxSeq}.json`)),
    scheduleRetry: () => { retries += 1; },
    takeRoutineMark: (id, executionId) => takeRoutineMark(id, executionId),
    backgroundWork: () => background.on,
    inbox,
    rebuildHeld: () => hold.on,
    recordProgress: async (lead, row) => { progress.push({ lead: lead.sessionId, ...row }); },
  };
  return { d, delivered, sessions, busy, hold, progress, background, inbox, retries: () => retries };
}

beforeEach(() => { _resetTeamState(); });

const completed = (extra: Record<string, unknown> = {}) => ({
  sessionId: 'worker', status: 'completed' as const, finalOutput: 'Done. Output in out/report.md', trigger: 'team-lead', ...extra,
});

test('a lead-started worker turn is reported to the lead with a status line and the final reply', async () => {
  const { d, delivered } = deps();
  await onWorkerTurnCompleted(completed(), d);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'web:lead');
  assert.equal(delivered[0].origin, 'worker-result');
  assert.equal(delivered[0].text, '[Worker alpha · completed]\nstatus idle\n\nDone. Output in out/report.md');
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
    isRunning: () => false, isQueued: () => false, pendingInteractions: () => [], openWaitpoints: async () => 0,
    history: async () => null, now: () => 0,
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
    isRunning: () => false, isQueued: () => false, pendingInteractions: () => [], openWaitpoints: async () => 0,
    history: async () => null, now: () => 0,
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

// ── routine updates and the lead inbox ─────────────────────────────────────

/** A worker turn of run `exec-1` that the worker marked routine. */
const routineTurn = (extra: Record<string, unknown> = {}) => {
  markTurnRoutine('worker', 'exec-1');
  return completed({ executionId: 'exec-1', ...extra });
};

test('every unmarked reply is a report delivered at once, whatever the worker still has running', async () => {
  const { d, delivered, progress, background } = deps();
  background.on = true;
  await onWorkerTurnCompleted(completed({ finalOutput: 'Step 1 done; the download keeps running.' }), d);
  await onWorkerTurnCompleted(completed({ finalOutput: 'Step 2 done.', trigger: 'external-signal' }), d);
  assert.equal(delivered.length, 2, 'no gating, no coalescing');
  assert.match(delivered[0].text, /^\[Worker alpha · completed\]\nstatus running\n\nStep 1 done/);
  assert.deepEqual(background.described, [true, true], 'a backgrounded agent keeps it running past the turn');
  assert.deepEqual(progress, []);
});

test('the status line of a report does not count the ending turn itself as running', async () => {
  const { d, delivered, background } = deps();
  await onWorkerTurnCompleted(completed(), d);
  assert.deepEqual(background.described, [false]);
  assert.match(delivered[0].text, /\nstatus idle\n/);
});

test('a routine turn is a progress row and an unread inbox item, and wakes nobody', async () => {
  const { d, delivered, progress, inbox } = deps();
  await onWorkerTurnCompleted(routineTurn({ finalOutput: '\nDownload at 40%, nothing new.\nDetails: 12 GB of 30.' }), d);
  assert.equal(delivered.length, 0);
  assert.deepEqual(progress, [{
    lead: 'lead', text: 'Download at 40%, nothing new.\nDetails: 12 GB of 30.', worker: { name: 'alpha', sessionId: 'worker' },
    ts: new Date(1_000).toISOString(),
  }]);
  assert.deepEqual(await inbox.take('lead'), [{
    workerId: 'worker', name: 'alpha', items: [{ at: 1_000, text: 'Download at 40%, nothing new.' }], dropped: 0,
  }]);
  const team = await describeTeam('lead', {
    isRunning: () => false, isQueued: () => false, pendingInteractions: () => [], openWaitpoints: async () => 0,
    history: async () => null, now: () => 0,
  }, async () => [WORKER as any]);
  assert.match(team[0].lastReport!.text, /Download at 40%, nothing new\./, 'worker_list still shows the latest reply');
});

test('a routine mark covers only the run it was made in, and is consumed by its turn', async () => {
  const { d, delivered } = deps();
  markTurnRoutine('worker', 'exec-old');
  await onWorkerTurnCompleted(completed({ executionId: 'exec-new' }), d);
  assert.equal(delivered.length, 1, 'a mark left by another run does not hide this report');
  await onWorkerTurnCompleted(completed({ executionId: 'exec-new' }), d);
  assert.equal(delivered.length, 2, 'the stale mark was consumed');
  markTurnRoutine('worker', null);
  await onWorkerTurnCompleted(completed({ executionId: 'exec-x' }), d);
  assert.equal(delivered.length, 2, 'a mark made with no registered run applies to the next turn');
});

test('a failed or stopped turn reports even when marked routine', async () => {
  for (const status of ['failed', 'stopped'] as const) {
    const { d, delivered, progress } = deps();
    await onWorkerTurnCompleted(routineTurn({ status, finalOutput: 'x' }), d);
    assert.equal(delivered.length, 1, status);
    assert.deepEqual(progress, []);
  }
});

test('a routine mark in a turn the user typed is consumed and nothing is reported', async () => {
  const { d, delivered, progress } = deps();
  await onWorkerTurnCompleted(routineTurn({ trigger: 'web-user' }), d);
  assert.equal(delivered.length, 0);
  assert.deepEqual(progress, []);
  assert.equal(takeRoutineMark('worker', 'exec-1'), false);
});

test('the next report carries the unread routine updates as its last section, then they are read', async () => {
  const { d, delivered, inbox } = deps();
  await onWorkerTurnCompleted(routineTurn({ finalOutput: 'Download at 40%' }), d);
  await onWorkerTurnCompleted(routineTurn({ finalOutput: 'Download at 80%' }), d);
  await onWorkerTurnCompleted(completed({ finalOutput: 'Download finished: data/set.tar' }), d);
  assert.equal(delivered.length, 1);
  const [report, digest] = delivered[0].text.split(`\n\n${UNREAD_DIGEST_HEADER}\n`);
  assert.match(report, /Download finished: data\/set\.tar$/);
  assert.match(digest, /^alpha:\n- \d\d(-\d\d \d\d)?:\d\d Download at 40%\n- \S+( \S+)? Download at 80%$/);
  assert.deepEqual(await inbox.take('lead'), [], 'read once given');
  await onWorkerTurnCompleted(completed({ finalOutput: 'Next' }), d);
  assert.ok(!delivered[1].text.includes(UNREAD_DIGEST_HEADER), 'nothing unread, no section');
});

test('a forwarded question carries the unread updates too', async () => {
  const { d, delivered } = deps();
  await onWorkerTurnCompleted(routineTurn({ finalOutput: 'Still training, epoch 3' }), d);
  await notifyLeadOfWorkerRequest({ requestId: 'req-1', sessionId: 'worker', kind: 'ask-user', blocking: true, questions: [{ question: 'Which split?' }] }, d);
  assert.equal(delivered[0].origin, 'worker-question');
  assert.match(delivered[0].text, new RegExp(`Q1: Which split\\?[\\s\\S]*\\n\\n\\${UNREAD_DIGEST_HEADER}\\nalpha:\\n- .* Still training, epoch 3$`));
});

test('updates taken for a report a restart refused are unread again', async () => {
  const { d, delivered, hold, inbox } = deps();
  await onWorkerTurnCompleted(routineTurn({ finalOutput: 'Routine check ok' }), d);
  hold.on = true;
  await onWorkerTurnCompleted(completed({ finalOutput: 'Report' }), d);
  await notifyLeadOfWorkerRequest({ requestId: 'req-2', sessionId: 'worker', kind: 'ask-user', blocking: true, questions: [] }, d);
  assert.equal(delivered.length, 0);
  const unread = await inbox.take('lead');
  assert.deepEqual(unread.map(w => w.items.map(i => i.text)), [['Routine check ok']]);
});

test('the inbox keeps the newest updates per worker and says how many older ones it dropped', async () => {
  const inbox = new TeamInboxRepo(path.join(process.env.CORTEX_HOME!, 'data', 'team-inbox-cap.json'), 2);
  for (const [at, text] of [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']] as const) {
    await inbox.add('lead', { workerId: 'w1', name: 'alpha' }, { at, text });
  }
  await inbox.add('lead', { workerId: 'w2', name: 'beta' }, { at: 0, text: 'z' });
  await inbox.add('other-lead', { workerId: 'w3', name: 'gamma' }, { at: 5, text: 'y' });
  const taken = await inbox.take('lead');
  assert.deepEqual(taken, [
    { workerId: 'w2', name: 'beta', items: [{ at: 0, text: 'z' }], dropped: 0 },
    { workerId: 'w1', name: 'alpha', items: [{ at: 3, text: 'c' }, { at: 4, text: 'd' }], dropped: 2 },
  ]);
  await inbox.add('lead', { workerId: 'w1', name: 'alpha' }, { at: 9, text: 'e' });
  await inbox.restore('lead', taken);
  assert.deepEqual((await inbox.take('lead')).find(w => w.workerId === 'w1'),
    { workerId: 'w1', name: 'alpha', items: [{ at: 4, text: 'd' }, { at: 9, text: 'e' }], dropped: 3 });
  assert.equal((await new TeamInboxRepo(path.join(process.env.CORTEX_HOME!, 'data', 'team-inbox-cap.json')).take('other-lead')).length, 1,
    'persisted across instances');
});

test('the digest lists each worker under its name, one line per update, with times', () => {
  const now = new Date(2026, 9, 11, 15, 0).getTime();
  const digest = formatUnreadDigest([
    { workerId: 'w1', name: 'alpha', items: [{ at: new Date(2026, 9, 11, 9, 5).getTime(), text: 'Download at 40%' }], dropped: 0 },
    { workerId: 'w2', name: 'beta', items: [{ at: new Date(2026, 9, 10, 23, 59).getTime(), text: 'Check ok' }], dropped: 3 },
  ], now);
  assert.equal(digest, [
    '[Unread routine updates]',
    'alpha:',
    '- 09:05 Download at 40%',
    'beta (3 older not shown):',
    '- 10-10 23:59 Check ok',
  ].join('\n'));
  assert.equal(formatUnreadDigest([], now), '');
  assert.equal(inboxLine('\n  **Status**: fine\nmore'), '**Status**: fine');
  assert.equal(inboxLine('x'.repeat(300)).length, 200);
});

// ── restart safety ──────────────────────────────────────────────────────────

test('the process stays busy from the worker turn ending until the lead has the report', async () => {
  const bus = new EventBus();
  const { d, delivered, busy } = deps();
  installTeamDelivery(bus, d);
  // The worker's turn holds its own count; its ending is published before the turn releases it.
  d.track(+1);
  bus.publish({ type: 'session.turn.completed', channel: 'web:worker', ...completed() });
  d.track(-1);
  assert.equal(busy.count, 1, 'the handoff holds the count the turn just let go of');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(delivered.length, 1);
  assert.deepEqual(busy.idleAt, [1], 'the only idle comes after the report was admitted');
});

test('a report refused by a pending restart is kept, not lost, and the bracket still closes once', async () => {
  const { d, delivered, busy, hold, retries } = deps();
  hold.on = true;
  await onWorkerTurnCompleted(completed({ status: 'failed', finalOutput: 'Broke at step 3' }), d);
  assert.equal(delivered.length, 0);
  assert.equal(busy.count, 0);
  assert.deepEqual(busy.idleAt, [0], 'idle only after the report is on disk');
  assert.equal(retries(), 1, 'retried in case the restart never comes');
  const kept = await d.outbox.list();
  assert.equal(kept.length, 1);
  assert.deepEqual(
    { leadId: kept[0].leadId, workerId: kept[0].workerId, status: kept[0].status, text: kept[0].text, at: kept[0].at },
    { leadId: 'lead', workerId: 'worker', status: 'failed', text: 'Broke at step 3', at: 1_000 },
  );
});

test('kept reports survive a fresh process and are delivered to the lead, then cleared', async () => {
  const file = path.join(process.env.CORTEX_HOME!, 'data', 'team-outbox-restart.json');
  const before = deps({ outbox: new TeamOutboxRepo(file) });
  before.hold.on = true;
  await onWorkerTurnCompleted(completed({ finalOutput: 'All tests pass' }), before.d);

  // The restart: memory is gone, the file is not.
  _resetTeamState();
  const after = deps({ outbox: new TeamOutboxRepo(file) });
  assert.equal(await flushTeamOutbox(after.d), 1);
  assert.equal(after.delivered.length, 1);
  assert.equal(after.delivered[0].channel, 'web:lead');
  assert.equal(after.delivered[0].origin, 'worker-result');
  assert.match(after.delivered[0].text, /^\[Worker alpha · completed\][\s\S]*All tests pass$/);
  assert.deepEqual(await new TeamOutboxRepo(file).list(), []);
  assert.equal(after.busy.count, 0);
  const team = await describeTeam('lead', {
    isRunning: () => false, isQueued: () => false, pendingInteractions: () => [], openWaitpoints: async () => 0,
    history: async () => ({ events: [{ type: 'assistant', text: 'something else', ts: '' }] } as any), now: () => 0,
  }, async () => [WORKER as any]);
  assert.equal(team[0].lastReport!.text, 'All tests pass', 'worker_list shows what the lead was just given');
});

test('a flush still under a hold keeps the report for the retry', async () => {
  const { d, delivered, hold, retries } = deps();
  await d.outbox.add({ id: 'worker:1', leadId: 'lead', workerId: 'worker', status: 'completed', text: 'x', at: 1 });
  hold.on = true;
  assert.equal(await flushTeamOutbox(d), 0);
  assert.equal(delivered.length, 0);
  assert.equal((await d.outbox.list()).length, 1);
  assert.equal(retries(), 1);
  hold.on = false;
  assert.equal(await flushTeamOutbox(d), 1);
  assert.deepEqual(await d.outbox.list(), []);
});

test('kept reports whose lead is gone, or that meet team mode off, are dropped', async () => {
  const gone = deps({ lead: false });
  await gone.d.outbox.add({ id: 'worker:1', leadId: 'lead', workerId: 'worker', status: 'completed', text: 'x', at: 1 });
  assert.equal(await flushTeamOutbox(gone.d), 0);
  assert.deepEqual(await gone.d.outbox.list(), []);

  const off = deps({ enabled: false });
  await off.d.outbox.add({ id: 'worker:1', leadId: 'lead', workerId: 'worker', status: 'completed', text: 'x', at: 1 });
  assert.equal(await flushTeamOutbox(off.d), 0);
  assert.equal(off.delivered.length, 0);
  assert.deepEqual(await off.d.outbox.list(), []);
});

test('with team mode off the subscriber takes no busy bracket', async () => {
  const { d, busy } = deps({ enabled: false });
  await onWorkerTurnCompleted(completed(), d);
  assert.deepEqual(busy, { count: 0, idleAt: [] });
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

test('a worker plan reaches the lead, which can approve or reject it', async () => {
  const r = routing();
  const approval = registerPlanApproval('req-plan', 'web:worker', 'worker', '# Plan\n1. step', { plan_file_path: '/p/plan.md' });
  await flush();
  assert.match(r.delivered[0].text, /^\[Worker alpha · plan approval · request_id=req-plan · blocking\]/);
  assert.match(r.delivered[0].text, /Plan file: \/p\/plan\.md\n# Plan\n1\. step/);
  assert.equal(respondToPlan({ planApprovals: r.planApprovals, interactionRecords: r.interactions }, 'req-plan', true, '', 'agent'), 'resolved');
  assert.equal((await approval).approved, true, 'the blocked submit sees the approval');

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
