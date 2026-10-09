import { afterEach, beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { resetSettingsForTests } from '../../src/core/settings.js';
import { composeUserPrompt } from '../../src/domain/runs/prompt.js';
import { resolveConversationTeam } from '../../src/orchestration/conversation-request.js';
import type { WorkerView } from '../../src/orchestration/team-state.js';

function view(name: string, extra: Partial<WorkerView> = {}): WorkerView {
  return {
    name, sessionId: `s-${name}`, channel: `web:s-${name}`, status: 'idle', waitingOn: [], waitpoints: 0, brief: 'Fix the flaky test',
    lastReport: { status: 'completed', text: 'done', at: 0 }, userTouched: false, retired: false,
    ...extra,
  };
}

const SESSIONS: Record<string, any> = {
  lead: { sessionId: 'lead', name: 'cortex-lead', label: 'Release prep', teamLeadId: null },
  worker: { sessionId: 'worker', name: 'cortex-w', label: 'alpha', teamLeadId: 'lead', workerName: 'alpha' },
  plain: { sessionId: 'plain', name: 'cortex-p', label: null, teamLeadId: null },
};
const getSession = async (id: string) => SESSIONS[id] ?? null;

beforeEach(() => { process.env.CORTEX_TEAM_ENABLED = '1'; resetSettingsForTests(); });
afterEach(() => { delete process.env.CORTEX_TEAM_ENABLED; resetSettingsForTests(); });

test('a lead gets the [Team] roster only while it has active workers', async () => {
  const none = await resolveConversationTeam(SESSIONS.lead, { teamLead: true }, { describeTeam: async () => [] });
  assert.deepEqual(none, { team: null, worker: null });
  const retiredOnly = await resolveConversationTeam(SESSIONS.lead, { teamLead: true }, {
    describeTeam: async () => [view('old', { retired: true, status: 'retired' })],
  });
  assert.equal(retiredOnly.team, null);

  const withWorkers = await resolveConversationTeam(SESSIONS.lead, { teamLead: true }, {
    describeTeam: async () => [
      view('alpha', { status: 'waiting', waitingOn: ['req-1'], userTouched: true }),
      view('old', { retired: true, status: 'retired' }),
    ],
    now: () => 120_000,
  });
  assert.deepEqual(withWorkers.team!.roster, [
    '- alpha · waiting(req-1) · last report 2m ago · user talked to it directly — Fix the flaky test',
  ]);
  const prompt = composeUserPrompt({}, 'hello', withWorkers);
  assert.match(prompt, /^\[Team\] You lead these workers/);
  assert.match(prompt, /end your turn/);
  assert.match(prompt, /worker_send/);
  assert.match(prompt, /cortex_ask_user only when you are unsure/);
  assert.match(prompt, /hello$/);
});

test('a worker gets the [Worker] block on its first turn only', async () => {
  const first = await resolveConversationTeam(SESSIONS.worker, { isFreshSession: true }, { getSession });
  assert.deepEqual(first, { team: null, worker: { name: 'alpha', lead: 'Release prep' } });
  const prompt = composeUserPrompt({}, 'task', first);
  assert.match(prompt, /^\[Worker\] You are worker "alpha" of the lead session "Release prep"/);
  assert.match(prompt, /delivered to the lead/);
  assert.match(prompt, /cannot create workers/);

  assert.deepEqual(await resolveConversationTeam(SESSIONS.worker, { isFreshSession: false }, { getSession }), { team: null, worker: null });
  assert.deepEqual(await resolveConversationTeam(SESSIONS.plain, { isFreshSession: true }, { getSession }), { team: null, worker: null });
});

test('with team mode off nothing is injected for a worker', async () => {
  process.env.CORTEX_TEAM_ENABLED = '0';
  resetSettingsForTests();
  assert.deepEqual(await resolveConversationTeam(SESSIONS.worker, { isFreshSession: true }, { getSession }), { team: null, worker: null });
  assert.equal(composeUserPrompt({}, 'plain', { team: null, worker: null }), 'plain');
});
