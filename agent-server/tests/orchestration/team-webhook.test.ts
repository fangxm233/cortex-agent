import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { resetSettingsForTests } from '../../src/core/settings.js';
import { handleTeamWebhook, type TeamWebhookDeps } from '../../src/orchestration/team-webhook.js';
import {
  _resetTeamState, clearDispatch, describeTeam, noteWorkerRequest, workerNameForRequest, type WorkerViewDeps,
} from '../../src/orchestration/team-state.js';
import { MAX_RUNNING_WORKERS } from '../../src/domain/sessions/team.js';
import type {
  ApplySelectionRequest, ApplySelectionResult, ChannelSelection,
} from '../../src/domain/agents/model-selection.js';

function session(id: string, extra: Record<string, unknown> = {}): any {
  return {
    sessionId: id, channel: `web:${id}`, origin: 'direct', projectId: 'proj',
    backend: 'claude', kind: 'local', createdAt: '', lastUsedAt: '', label: null, profileName: null,
    ...extra,
  };
}

interface World {
  sessions: Map<string, any>;
  running: Set<string>;
  pending: Map<string, { id: string }[]>;
  waitpoints: Map<string, number>;
  routine: string[];
  delivered: Array<{ channel: string; text: string; origin: string }>;
  cancelled: string[];
  answered: any[];
  records: Map<string, any>;
  /** What each channel runs; the lead's is seeded, a worker's is what spawn applied. */
  selections: Map<string, ChannelSelection>;
  applied: ApplySelectionRequest[];
  /** When set, the next applySelection refuses with this. */
  refuse: Partial<ApplySelectionResult> | null;
  /** The server refuses new turns ahead of a restart. */
  held: boolean;
  deps: TeamWebhookDeps;
}

function world(): World {
  const w = {
    sessions: new Map<string, any>([['lead', session('lead')]]),
    running: new Set<string>(),
    pending: new Map<string, { id: string }[]>(),
    waitpoints: new Map<string, number>(),
    routine: [] as string[],
    delivered: [] as World['delivered'],
    cancelled: [] as string[],
    answered: [] as any[],
    records: new Map<string, any>(),
    selections: new Map<string, ChannelSelection>([['web:lead', {
      profileName: 'lead-profile', backend: 'claude', model: 'claude-opus-5', provider: null,
      thinking: 'high', mode: 'plan', override: { model: 'claude-opus-5', thinking: 'high' },
    }]]),
    applied: [] as ApplySelectionRequest[],
    refuse: null,
    held: false,
  } as World;
  let next = 0;
  const listWorkers = async (leadId: string) => [...w.sessions.values()].filter(s => s.teamLeadId === leadId);
  const viewDeps: WorkerViewDeps = {
    isRunning: (id) => w.running.has(id),
    isQueued: () => false,
    pendingInteractions: (channel) => w.pending.get(channel) ?? [],
    openWaitpoints: async (id) => w.waitpoints.get(id) ?? 0,
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
      const id = opts.sessionId;
      w.sessions.set(id, session(id, {
        teamLeadId: opts.teamLeadId, workerName: opts.workerName, workerBrief: opts.workerBrief,
        profileName: opts.profileName, projectId: opts.projectId, boardId: opts.boardId,
      }));
      return { sessionId: id, channel: `web:${id}` };
    },
    newSessionId: () => `w${++next}`,
    deliver: (opts) => { w.delivered.push(opts as any); },
    cancel: async (channel) => { w.cancelled.push(channel); return 1; },
    readSelection: (channel) => w.selections.get(channel)!,
    defaultProfile: (backend) => (backend === 'pi' ? 'pi-default' : 'claude-default'),
    providerProfile: () => null,
    applySelection: async (request) => {
      w.applied.push(request);
      if (w.refuse) return { ok: false, ...w.refuse } as ApplySelectionResult;
      const selection: ChannelSelection = {
        profileName: request.profileName!, backend: /^(pi|ds)/.test(request.profileName!) ? 'pi' : 'claude',
        model: request.model ?? 'profile-model', provider: request.provider ?? null,
        thinking: request.thinking ?? null, mode: request.mode ?? 'api', override: null,
      };
      w.selections.set(request.channel, selection);
      return { ok: true, backendChanged: false, ...selection };
    },
    interactions: { get: (id: string) => w.records.get(id) ?? null },
    answerQuestion: (id, answers) => { w.answered.push({ id, answers }); return 'resolved'; },
    questionTexts: (id) => (id === 'ask-2' ? ['Which?', 'Why?'] : null),
    respondPlan: (id, approved, feedback) => { w.answered.push({ id, approved, feedback }); return 'already-resolved'; },
    // Dispatches mark a worker running for a while; the clock is pinned past that window here so the
    // tests below decide "running" explicitly.
    describeTeam: (id) => describeTeam(id, { ...viewDeps, now: () => Number.MAX_SAFE_INTEGER }, listWorkers),
    held: () => w.held,
    markRoutine: (id: string) => { w.routine.push(id); },
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
  assert.equal(created.workerBrief, 'Refactor the API', 'the brief is stored on the record');
  assert.equal(created.label, 'api-refactor', 'the worker is titled by its name');
  assert.equal(created.profileName, 'lead-profile', 'the lead profile is inherited');
  // The lead's own pick rides along, written before the session exists and without moving the
  // composer default.
  assert.deepEqual(w.applied, [{
    channel: 'web:w1', profileName: 'lead-profile', model: 'claude-opus-5', provider: null,
    thinking: 'high', mode: null, seedDefault: false,
  }]);
  assert.equal(created.projectId, 'proj');
  assert.deepEqual(w.delivered, [{ channel: 'web:w1', text: 'Refactor the API\nmore detail', origin: 'team-lead' }]);
  assert.equal((reply.data as any).sessionId, 'w1');

  const listed = await call(w, { action: 'list' });
  assert.match((listed.data as any).text, /api-refactor .* — Refactor the API$/m);

  // After a restart the in-memory brief is gone; the record's brings it back.
  _resetTeamState();
  const relisted = await call(w, { action: 'list' });
  assert.match((relisted.data as any).text, /api-refactor .* — Refactor the API$/m);
});

test('a spawned worker inherits the lead board, and none when the lead has none', async () => {
  const w = world();
  await call(w, { action: 'spawn', name: 'plain', prompt: 'p' });
  assert.equal(w.sessions.get('w1').boardId, null);
  w.sessions.get('lead').boardId = 'b-1';
  await call(w, { action: 'spawn', name: 'boarded', prompt: 'p' });
  assert.equal(w.sessions.get('w2').boardId, 'b-1');
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
  assert.match(text, /^Model: claude claude-opus-5:high$/m);
  assert.match(text, /Brief: Investigate the flake/);
  assert.match(text, /No report yet/);
});

test('a worker with no turn running but an open waitpoint is waiting on external, not idle', async () => {
  const w = world();
  await call(w, { action: 'spawn', name: 'alpha', prompt: 'Train the model' });
  clearDispatch('w1');
  assert.match(((await call(w, { action: 'list' })).data as any).text, /^- alpha · idle · /m);
  w.waitpoints.set('w1', 2);
  assert.match(((await call(w, { action: 'list' })).data as any).text, /^- alpha · waiting on external \(2 waitpoints\) · /m);
  assert.match(((await call(w, { action: 'list', worker: 'alpha' })).data as any).text, /^Status: waiting on external \(2 waitpoints\)$/m);
  w.running.add('w1');
  assert.match(((await call(w, { action: 'list' })).data as any).text, /^- alpha · running · /m, 'a running turn wins');
});

test('a forwarded request names its worker; an unknown one falls back to the interaction session', async () => {
  const w = world();
  await call(w, { action: 'spawn', name: 'alpha', prompt: 'p' });
  await call(w, { action: 'list' });
  noteWorkerRequest('req-a', 'beta');
  assert.equal(workerNameForRequest('req-a', () => null), 'beta');
  assert.equal(workerNameForRequest('req-b', (id) => (id === 'req-b' ? 'w1' : null)), 'alpha');
  assert.equal(workerNameForRequest('req-c', () => null), null);
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

  w.records.set('ask-2', { id: 'ask-2', sessionId: 'w1', kind: 'ask-user', status: 'pending' });
  const partial = await call(w, { action: 'answer', request_id: 'ask-2', answers: { 'which?': 'A' } });
  assert.match(partial.error!, /exact question text; unanswered: "Which\?", "Why\?"/);
  assert.equal(w.answered.length, 2, 'an incomplete answer resolves nothing');
});

test('spawn with a model on the lead backend replaces only the fields it names', async () => {
  const w = world();
  w.selections.set('web:lead', {
    profileName: 'ds', backend: 'pi', model: 'deepseek-v4', provider: 'deepseek', thinking: 'high',
    mode: 'deepseek-plan', override: { model: 'deepseek-v4', thinking: 'high', mode: 'deepseek-plan' },
  });
  await call(w, { action: 'spawn', name: 'a', prompt: 'p', model: 'deepseek/deepseek-v4-flash' });
  assert.deepEqual(w.applied[0], {
    channel: 'web:w1', profileName: 'ds', model: 'deepseek-v4-flash', provider: 'deepseek',
    thinking: 'high', mode: 'deepseek-plan', seedDefault: false,
  }, 'same provider: the route and level stay the lead\'s');

  await call(w, { action: 'spawn', name: 'b', prompt: 'p', model: 'openai/gpt-6:low' });
  assert.deepEqual(w.applied[1], {
    channel: 'web:w2', profileName: 'ds', model: 'gpt-6', provider: 'openai',
    thinking: 'low', mode: null, seedDefault: false,
  }, 'another provider: the lead\'s route does not travel with it');

  const text = ((await call(w, { action: 'list', worker: 'b' })).data as any).text;
  assert.match(text, /^Model: pi openai\/gpt-6:low$/m);
});

test('spawn on the other backend starts from its default profile with only the parsed spec', async () => {
  const w = world();
  await call(w, { action: 'spawn', name: 'a', prompt: 'p', backend: 'pi', model: 'deepseek/deepseek-v4-flash:high' });
  assert.deepEqual(w.applied[0], {
    channel: 'web:w1', profileName: 'pi-default', model: 'deepseek-v4-flash', provider: 'deepseek',
    thinking: 'high', mode: null, seedDefault: false,
  });
  assert.equal(w.sessions.get('w1').profileName, 'pi-default');

  w.selections.set('web:lead', { ...w.selections.get('web:w1')!, profileName: 'pi-default' });
  await call(w, { action: 'spawn', name: 'b', prompt: 'p', backend: 'claude', model: 'anthropic/claude-sonnet-5' });
  assert.deepEqual(w.applied[1], {
    channel: 'web:w2', profileName: 'claude-default', model: 'claude-sonnet-5', provider: null,
    thinking: null, mode: null, seedDefault: false,
  }, 'a claude worker drops the provider segment');

  w.deps.defaultProfile = () => null;
  assert.match((await call(w, { action: 'spawn', name: 'c', prompt: 'p', backend: 'claude' })).error!,
    /no profile is configured for the claude backend/);
});

test('spawn moves a PI worker onto the profile configured for the provider it names', async () => {
  const w = world();
  w.deps.providerProfile = (provider) => (provider === 'openai' ? 'oa' : provider === 'deepseek' ? 'ds' : null);
  w.selections.set('web:lead', {
    profileName: 'ds', backend: 'pi', model: 'deepseek-v4', provider: 'deepseek', thinking: 'high',
    mode: 'deepseek-plan', override: { model: 'deepseek-v4', thinking: 'high', mode: 'deepseek-plan' },
  });
  await call(w, { action: 'spawn', name: 'a', prompt: 'p', model: 'openai/gpt-6:low' });
  assert.deepEqual(w.applied[0], {
    channel: 'web:w1', profileName: 'oa', model: 'gpt-6', provider: null, thinking: 'low', mode: null, seedDefault: false,
  });
  await call(w, { action: 'spawn', name: 'b', prompt: 'p', model: 'deepseek/deepseek-v4-flash' });
  assert.equal(w.applied[1].profileName, 'ds', 'the lead\'s own provider keeps the lead\'s profile');
  assert.equal(w.applied[1].mode, 'deepseek-plan');
});

test('spawn refuses a selection the rule rejects, and an unknown backend, creating nothing', async () => {
  const w = world();
  w.refuse = { reason: 'invalid-thinking', allowed: ['low', 'high'] };
  const refused = await call(w, { action: 'spawn', name: 'a', prompt: 'p', model: 'claude-opus-5:weird' });
  assert.equal(refused.success, false);
  assert.match(refused.error!, /invalid-thinking \(allowed: low, high\)/);

  w.refuse = null;
  const bad = await call(w, { action: 'spawn', name: 'b', prompt: 'p', backend: 'gpt' });
  assert.match(bad.error!, /backend must be "claude" or "pi"/);
  assert.equal(w.applied.length, 1, 'an invalid backend never reaches the rule');
  assert.equal([...w.sessions.values()].filter(s => s.teamLeadId).length, 0);
  assert.deepEqual(w.delivered, []);
});

test('spawn and send say so while the server is about to restart, creating and delivering nothing', async () => {
  const w = world();
  w.sessions.set('old', session('old', { teamLeadId: 'lead', workerName: 'old', workerRetiredAt: 5 }));
  w.held = true;

  const spawned = await call(w, { action: 'spawn', name: 'fresh', prompt: 'p' });
  assert.equal(spawned.success, false);
  assert.match(spawned.error!, /about to restart.*the worker was not created/);
  assert.equal(w.applied.length, 0, 'no selection written for a worker that does not exist');
  assert.equal([...w.sessions.values()].filter(s => s.workerName === 'fresh').length, 0);

  const sent = await call(w, { action: 'send', worker: 'old', message: 'go' });
  assert.equal(sent.success, false);
  assert.match(sent.error!, /about to restart.*the message was not delivered/);
  assert.equal(w.sessions.get('old').workerRetiredAt, 5, 'not revived by a send that did not happen');
  assert.deepEqual(w.delivered, []);

  w.held = false;
  assert.equal((await call(w, { action: 'send', worker: 'old', message: 'go' })).success, true);
  assert.equal(w.delivered.length, 1);
});

test('mark_routine is the one action a worker may call, and only a worker', async () => {
  const w = world();
  await call(w, { action: 'spawn', name: 'alpha', prompt: 'p' });
  const marked = await handleTeamWebhook({ action: 'routine', sessionId: 'w1' }, w.deps);
  assert.equal(marked.success, true);
  assert.match((marked.data as any).text, /does not wake it/);
  assert.deepEqual(w.routine, ['w1']);
  const byLead = await call(w, { action: 'routine' });
  assert.equal(byLead.success, false);
  assert.match(byLead.error!, /only available to a team worker/);
  assert.equal((await handleTeamWebhook({ action: 'spawn', sessionId: 'w1', name: 'x', prompt: 'p' }, w.deps)).success, false,
    'a worker cannot use the lead tools');
  assert.deepEqual(w.routine, ['w1']);
});
