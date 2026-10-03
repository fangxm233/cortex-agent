import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { resetSettingsForTests } from '../../src/core/settings.js';
import { handleTeamWebhook, type TeamWebhookDeps } from '../../src/orchestration/team-webhook.js';
import { _resetTeamState, describeTeam, type WorkerViewDeps } from '../../src/orchestration/team-state.js';
import { MAX_RUNNING_WORKERS } from '../../src/domain/sessions/team.js';

function session(id: string, extra: Record<string, unknown> = {}): any {
  return {
    sessionId: id, name: `cortex-${id}`, channel: `web:${id}`, origin: 'direct', projectId: 'proj',
    backend: 'claude', kind: 'local', createdAt: '', lastUsedAt: '', label: null, profileName: null,
    ...extra,
  };
}

interface World {
  sessions: Map<string, any>;
  running: Set<string>;
  pending: Map<string, { id: string }[]>;
  delivered: Array<{ channel: string; text: string; origin: string }>;
  cancelled: string[];
  answered: any[];
  records: Map<string, any>;
  deps: TeamWebhookDeps;
}

function world(): World {
  const w = {
    sessions: new Map<string, any>([['lead', session('lead')]]),
    running: new Set<string>(),
    pending: new Map<string, { id: string }[]>(),
    delivered: [] as World['delivered'],
    cancelled: [] as string[],
    answered: [] as any[],
    records: new Map<string, any>(),
  } as World;
  let next = 0;
  const listWorkers = async (leadId: string) => [...w.sessions.values()].filter(s => s.teamLeadId === leadId);
  const viewDeps: WorkerViewDeps = {
    isRunning: (id) => w.running.has(id),
    isQueued: () => false,
    pendingInteractions: (channel) => w.pending.get(channel) ?? [],
    history: async () => null,
    now: () => 0,
  };
  w.deps = {
    sessions: {
      getById: async (id: string) => w.sessions.get(id) ?? null,
      listWorkers,
      setWorkerRetired: async (id: string, at: number | null) => {
        const s = w.sessions.get(id); s.workerRetiredAt = at; return s;
      },
      rename: async (id: string, label: string) => { const s = w.sessions.get(id); s.label = label; return s; },
    } as any,
    createSession: async (opts) => {
      const id = `w${++next}`;
      w.sessions.set(id, session(id, { teamLeadId: opts.teamLeadId, workerName: opts.workerName, profileName: opts.profileName, projectId: opts.projectId }));
      return { sessionId: id, channel: `web:${id}` };
    },
    deliver: (opts) => { w.delivered.push(opts as any); },
    cancel: async (channel) => { w.cancelled.push(channel); return 1; },
    activeProfile: () => 'lead-profile',
    interactions: { get: (id: string) => w.records.get(id) ?? null },
    answerQuestion: (id, answers) => { w.answered.push({ id, answers }); return 'resolved'; },
    respondPlan: (id, approved, feedback) => { w.answered.push({ id, approved, feedback }); return 'already-resolved'; },
    // Dispatches mark a worker running for a while; the clock is pinned past that window here so the
    // tests below decide "running" explicitly.
    describeTeam: (id) => describeTeam(id, { ...viewDeps, now: () => Number.MAX_SAFE_INTEGER }, listWorkers),
    now: () => 1000,
  };
  return w;
}

const call = (w: World, data: Record<string, unknown>) => handleTeamWebhook({ sessionId: 'lead', ...data }, w.deps);

beforeEach(() => {
  process.env.CORTEX_TEAM_ENABLED = '1';
  resetSettingsForTests();
  _resetTeamState();
});

afterEach(() => {
  delete process.env.CORTEX_TEAM_ENABLED;
  resetSettingsForTests();
});

test('every action refuses a caller that is not a lead', async () => {
  const w = world();
  w.sessions.set('slack', session('slack', { channel: 'slack:C1' }));
  w.sessions.set('worker', session('worker', { teamLeadId: 'lead', workerName: 'x' }));
  for (const sessionId of ['slack', 'worker', 'missing']) {
    const reply = await handleTeamWebhook({ action: 'list', sessionId }, w.deps);
    assert.equal(reply.success, false);
    assert.match(reply.error!, /team mode/);
  }
  process.env.CORTEX_TEAM_ENABLED = '0';
  resetSettingsForTests();
  assert.equal((await call(w, { action: 'list' })).success, false, 'team mode off refuses the lead too');
});

test('spawn creates a named worker under the lead and hands it the prompt as team-lead', async () => {
  const w = world();
  const reply = await call(w, { action: 'spawn', name: 'api-refactor', prompt: 'Refactor the API\nmore detail' });
  assert.equal(reply.success, true);
  const created = w.sessions.get('w1');
  assert.equal(created.teamLeadId, 'lead');
  assert.equal(created.workerName, 'api-refactor');
  assert.equal(created.label, 'api-refactor', 'the worker is titled by its name');
  assert.equal(created.profileName, 'lead-profile', 'the lead profile is inherited');
  assert.equal(created.projectId, 'proj');
  assert.deepEqual(w.delivered, [{ channel: 'web:w1', text: 'Refactor the API\nmore detail', origin: 'team-lead' }]);
  assert.equal((reply.data as any).sessionId, 'w1');

  const listed = await call(w, { action: 'list' });
  assert.match((listed.data as any).text, /api-refactor .* — Refactor the API$/m);
});

test('spawn validates the name, its uniqueness and the running cap', async () => {
  const w = world();
  for (const name of ['', 'Has Caps', '-lead', 'a'.repeat(33), 'under_score']) {
    assert.equal((await call(w, { action: 'spawn', name, prompt: 'p' })).success, false, name);
  }
  await call(w, { action: 'spawn', name: 'dup', prompt: 'p' });
  const dup = await call(w, { action: 'spawn', name: 'dup', prompt: 'p' });
  assert.match(dup.error!, /already exists.*worker_send/);
  w.sessions.get('w1').workerRetiredAt = 5;
  assert.match((await call(w, { action: 'spawn', name: 'dup', prompt: 'p' })).error!, /retired.*revive/);

  for (let i = 0; i < MAX_RUNNING_WORKERS; i++) {
    await call(w, { action: 'spawn', name: `w-${i}`, prompt: 'p' });
  }
  for (const s of w.sessions.values()) if (s.teamLeadId && s.workerRetiredAt == null) w.running.add(s.sessionId);
  const capped = await call(w, { action: 'spawn', name: 'one-more', prompt: 'p' });
  assert.match(capped.error!, /already running/);
});

test('send revives a retired worker, injects into a busy one, and respects the cap for an idle one', async () => {
  const w = world();
  await call(w, { action: 'spawn', name: 'alpha', prompt: 'p' });
  w.sessions.get('w1').workerRetiredAt = 5;
  const revived = await call(w, { action: 'send', worker: 'alpha', message: 'continue' });
  assert.equal(revived.success, true);
  assert.equal(w.sessions.get('w1').workerRetiredAt, null);
  assert.deepEqual(w.delivered.at(-1), { channel: 'web:w1', text: 'continue', origin: 'team-lead' });

  for (let i = 0; i < MAX_RUNNING_WORKERS; i++) {
    await call(w, { action: 'spawn', name: `b-${i}`, prompt: 'p' });
    w.running.add(`w${i + 2}`);
  }
  assert.match((await call(w, { action: 'send', worker: 'alpha', message: 'x' })).error!, /already running/);
  w.running.add('w1');
  assert.match(((await call(w, { action: 'send', worker: 'alpha', message: 'x' })).data as any).text, /running turn/);
  assert.match((await call(w, { action: 'send', worker: 'nobody', message: 'x' })).error!, /no worker named/);
});

test('stop cancels the worker channel and can retire it', async () => {
  const w = world();
  await call(w, { action: 'spawn', name: 'alpha', prompt: 'p' });
  const reply = await call(w, { action: 'stop', worker: 'alpha', retire: true });
  assert.equal(reply.success, true);
  assert.deepEqual(w.cancelled, ['web:w1']);
  assert.equal(w.sessions.get('w1').workerRetiredAt, 1000);
  assert.match(((await call(w, { action: 'list' })).data as any).text, /Retired: alpha/);
});

test('list with a name shows the worker detail; waiting lists its request ids', async () => {
  const w = world();
  await call(w, { action: 'spawn', name: 'alpha', prompt: 'Investigate the flake' });
  w.pending.set('web:w1', [{ id: 'req-9' }]);
  const text = ((await call(w, { action: 'list', worker: 'alpha' })).data as any).text;
  assert.match(text, /Status: waiting\(req-9\)/);
  assert.match(text, /Brief: Investigate the flake/);
  assert.match(text, /No report yet/);
});

test('answer only resolves requests raised by this lead’s own workers, by kind', async () => {
  const w = world();
  await call(w, { action: 'spawn', name: 'alpha', prompt: 'p' });
  w.records.set('ask-1', { id: 'ask-1', sessionId: 'w1', kind: 'ask-user', status: 'pending' });
  w.records.set('plan-1', { id: 'plan-1', sessionId: 'w1', kind: 'plan-approval', status: 'pending' });
  w.records.set('foreign', { id: 'foreign', sessionId: 'other', kind: 'ask-user', status: 'pending' });

  const asked = await call(w, { action: 'answer', request_id: 'ask-1', answers: { 'Which?': 'A' } });
  assert.equal((asked.data as any).outcome, 'resolved');
  assert.deepEqual(w.answered[0], { id: 'ask-1', answers: { 'Which?': 'A' } });

  const planned = await call(w, { action: 'answer', request_id: 'plan-1', approved: false, feedback: 'smaller' });
  assert.equal((planned.data as any).outcome, 'already-resolved');
  assert.deepEqual(w.answered[1], { id: 'plan-1', approved: false, feedback: 'smaller' });

  assert.match((await call(w, { action: 'answer', request_id: 'foreign', answers: {} })).error!, /does not belong/);
  assert.equal(((await call(w, { action: 'answer', request_id: 'gone' })).data as any).outcome, 'not-found');
  assert.match((await call(w, { action: 'answer', request_id: 'plan-1' })).error!, /approved/);
  assert.match((await call(w, { action: 'answer', request_id: 'ask-1' })).error!, /answers required/);
});
