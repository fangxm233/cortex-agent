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
  const none = await resolveConversationTeam(SESSIONS.lead, { teamLead: true }, { describeTeam: async () => [], takeUnread: async () => '' });
  assert.deepEqual(none, { team: null, worker: null });
  const retiredOnly = await resolveConversationTeam(SESSIONS.lead, { teamLead: true }, {
    describeTeam: async () => [view('old', { retired: true, status: 'retired' })], takeUnread: async () => '',
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

test('unread routine updates close the [Team] block, and are taken once per turn', async () => {
  const digest = '[Unread routine updates]\nalpha:\n- 09:05 Download at 40%';
  const taken: string[] = [];
  const takeUnread = async (id: string) => { taken.push(id); return taken.length === 1 ? digest : ''; };
  const first = await resolveConversationTeam(SESSIONS.lead, { teamLead: true }, {
    describeTeam: async () => [view('alpha')], takeUnread, now: () => 0,
  });
  const prompt = composeUserPrompt({}, 'hello', first);
  assert.match(prompt, /Updates a worker marks routine do not wake you; they appear under \[Unread routine updates\]/);
  assert.ok(prompt.includes(`Do not run repeated review loops on a worker's output.\n\n${digest}\n\nhello`));
  const second = await resolveConversationTeam(SESSIONS.lead, { teamLead: true }, {
    describeTeam: async () => [view('alpha')], takeUnread, now: () => 0,
  });
  assert.equal(second.team!.unread, undefined);
  assert.deepEqual(taken, ['lead', 'lead']);

  const retiredWithNews = await resolveConversationTeam(SESSIONS.lead, { teamLead: true }, {
    describeTeam: async () => [view('old', { retired: true, status: 'retired' })], takeUnread: async () => digest,
  });
  assert.deepEqual(retiredWithNews.team, { roster: [], unread: digest }, 'unread news still reaches a lead with no active workers');
  assert.match(composeUserPrompt({}, 'x', retiredWithNews), /- \(no active workers\)/);
});

test('a worker gets the [Worker] block on its first turn only', async () => {
  const first = await resolveConversationTeam(SESSIONS.worker, { isFreshSession: true }, { getSession });
  assert.deepEqual(first, { team: null, worker: { name: 'alpha', lead: 'Release prep' } });
  const prompt = composeUserPrompt({}, 'task', first);
  assert.match(prompt, /^\[Worker\] You are worker "alpha" of the lead session "Release prep"/);
  assert.match(prompt, /delivered to the lead and wakes it/);
  assert.match(prompt, /call mark_routine before your final reply/);
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
