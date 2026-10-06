import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// A schedule's fire opens an ordinary session of its own and hands it the prompt as its first turn.
// These tests pin what that session looks like, that the fire never moves what the next new
// conversation opens on, that a retired thread target still fires, and that a fire is skipped
// while the schedule's previous run is still going.

const HOME = process.env.CORTEX_HOME!;
mkdirSync(path.join(HOME, 'config'), { recursive: true });
writeFileSync(path.join(HOME, 'config', 'profiles.json'), JSON.stringify({
  defaultProfile: 'opus',
  profiles: {
    opus: { model: 'claude-opus-5', backend: 'claude', mode: 'plan' },
    sonnet: { model: 'claude-sonnet-5', backend: 'claude', mode: 'plan' },
  },
}));
// An installed skill whose name is an ordinary English word: a prompt starting with it is prose.
mkdirSync(path.join(HOME, 'plugins', 'cortex-maintain', 'skills', 'release'), { recursive: true });
writeFileSync(path.join(HOME, 'plugins', 'cortex-maintain', 'skills', 'release', 'SKILL.md'),
  '---\nname: release\ndescription: Cut a release\n---\n');

const running: Array<{ status: string; kind: string | null; scheduleTaskId?: string | null }> = [];
vi.mock('../../../src/domain/executions/registry.js', () => ({
  getRunningExecutions: () => running,
}));

const { fireScheduledTask } = await import('../../../src/domain/scheduling/jobs/scheduled-task.js');
const { ctx } = await import('../../../src/domain/scheduling/job-registry.js');
const { createDirectSession } = await import('../../../src/domain/sessions/session-lifecycle.js');
const { getSessionAsync, setSessionAsync } = await import('../../../src/domain/sessions/session.js');
const { sessionStore } = await import('../../../src/store/session-registry-repo.js');
const { conversationLedger } = await import('../../../src/store/conversation-ledger-repo.js');
const { applyChannelSelection, getActiveProfile, getSelectionDefault } = await import('../../../src/domain/agents/index.js');
const { projectStore } = await import('../../../src/domain/projects/index.js');
const { hasRunningExecutionForSchedule } = await import('../../../src/domain/scheduling/run-guards.js');
const { conversationTrigger } = await import('../../../src/orchestration/conversation-request.js');

let deliver: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn>;
let ids = 0;

function makeDeps() {
  const sessionId = `sid-${++ids}`;
  const applySelection = vi.fn(applyChannelSelection);
  const createSession = vi.fn((opts: Parameters<typeof createDirectSession>[1]) => createDirectSession({
    sessionStore,
    setChannelSession: setSessionAsync,
    initConversation: async (channel, a) => { await conversationLedger.initConversation(channel, a); },
    resolveBackend: () => 'claude',
  }, opts));
  return { sessionId, deps: { applySelection, createSession, newSessionId: () => sessionId } };
}

function fire(overrides: Partial<Parameters<typeof fireScheduledTask>[0]> = {}) {
  return {
    message: '[Scheduled Task] summarize new arxiv papers',
    projectId: 'proj-a',
    scheduleTaskId: 'sch-1',
    profileName: 'sonnet',
    ...overrides,
  };
}

beforeEach(() => {
  running.length = 0;
  deliver = vi.fn(async () => {});
  notify = vi.fn(async () => {});
  ctx.deliverScheduledTurn = deliver as never;
  ctx.notify = notify as never;
  vi.spyOn(projectStore, 'exists').mockImplementation((id: string) => id === 'proj-a');
});

afterEach(() => {
  vi.restoreAllMocks();
  ctx.deliverScheduledTurn = null;
  ctx.notify = null;
});

test('a fire opens a scheduled session on its own web channel and delivers the prompt once', async () => {
  const { sessionId, deps } = makeDeps();
  await fireScheduledTask(fire(), deps);

  const channel = `web:${sessionId}`;
  const record = await sessionStore.getById(sessionId);
  expect(record).toMatchObject({
    sessionId,
    channel,
    origin: 'scheduled',
    kind: 'scheduled',
    scheduleId: 'sch-1',
    projectId: 'proj-a',
    profileName: 'sonnet',
    label: '[Scheduled Task] summarize new arxiv papers',
  });
  expect(await getSessionAsync(channel)).toBe(sessionId);
  expect((await conversationLedger.getConversation(channel))?.sessionId).toBe(sessionId);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledWith({ channel, text: '[Scheduled Task] summarize new arxiv papers' });
  expect(notify).not.toHaveBeenCalled();
});

test('a prompt whose first word names an installed skill is delivered verbatim', async () => {
  const { sessionId, deps } = makeDeps();
  await fireScheduledTask(fire({ scheduleTaskId: 'sch-skill-word', message: 'release the build tonight' }), deps);
  expect(deliver).toHaveBeenCalledWith({ channel: `web:${sessionId}`, text: 'release the build tonight' });
});

test('a schedule bound to an unknown project lands in general', async () => {
  const { sessionId, deps } = makeDeps();
  await fireScheduledTask(fire({ projectId: 'C0LEGACY', scheduleTaskId: 'sch-legacy' }), deps);
  expect((await sessionStore.getById(sessionId))?.projectId).toBe('general');
});

test('the profile is applied to the new channel without moving what the next conversation opens on', async () => {
  const { sessionId, deps } = makeDeps();
  const before = getSelectionDefault();
  await fireScheduledTask(fire({ scheduleTaskId: 'sch-2' }), deps);

  expect(deps.applySelection).toHaveBeenCalledWith({
    channel: `web:${sessionId}`, profileName: 'sonnet', seedDefault: false,
  });
  // Written before the session exists, so the first turn already runs on it.
  expect(deps.applySelection.mock.invocationCallOrder[0])
    .toBeLessThan(deps.createSession.mock.invocationCallOrder[0]);
  expect(getActiveProfile(`web:${sessionId}`)).toBe('sonnet');
  expect(getSelectionDefault()).toEqual(before);
});

test('a profile that will not apply opens nothing and says so', async () => {
  const { sessionId, deps } = makeDeps();
  await fireScheduledTask(fire({ scheduleTaskId: 'sch-3', profileName: 'no-such-profile' }), deps);

  expect(deps.createSession).not.toHaveBeenCalled();
  expect(await sessionStore.getById(sessionId)).toBeNull();
  expect(deliver).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0]).toMatchObject({ type: 'project-report', projectId: 'proj-a' });
});

test('a schedule still carrying a thread target fires as a fresh session', async () => {
  const { sessionId, deps } = makeDeps();
  const legacy = { ...fire({ scheduleTaskId: 'sch-thread' }), target: { kind: 'thread', threadId: 'thr_1', channel: 'C1' } };
  await fireScheduledTask(legacy as Parameters<typeof fireScheduledTask>[0], deps);

  expect((await sessionStore.getById(sessionId))?.channel).toBe(`web:${sessionId}`);
  expect(deliver).toHaveBeenCalledTimes(1);
});

test('a fire is skipped while the schedule\'s previous run is still going', async () => {
  // The run of an un-adopted scheduled session is recorded as a scheduled execution of its
  // schedule, which is exactly what the guard looks for.
  const trigger = conversationTrigger({ origin: 'scheduled', scheduleId: 'sch-4' });
  expect(trigger).toEqual({ trigger: 'scheduled', executionKind: 'scheduled', scheduleTaskId: 'sch-4' });
  running.push({ status: 'running', kind: trigger.executionKind, scheduleTaskId: trigger.scheduleTaskId });
  expect(hasRunningExecutionForSchedule(running as never, 'sch-4')).toBe(true);

  const { deps } = makeDeps();
  await fireScheduledTask(fire({ scheduleTaskId: 'sch-4' }), deps);
  expect(deps.applySelection).not.toHaveBeenCalled();
  expect(deps.createSession).not.toHaveBeenCalled();
  expect(deliver).not.toHaveBeenCalled();

  // Another schedule is not held up by it.
  const other = makeDeps();
  await fireScheduledTask(fire({ scheduleTaskId: 'sch-5' }), other.deps);
  expect(deliver).toHaveBeenCalledTimes(1);
});

test('a second fire before the first run\'s turn is admitted is skipped', async () => {
  let admit!: () => void;
  deliver.mockImplementationOnce(() => new Promise<void>((resolve) => { admit = resolve; }));
  const first = makeDeps();
  const pending = fireScheduledTask(fire({ scheduleTaskId: 'sch-6' }), first.deps);
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

  const second = makeDeps();
  await fireScheduledTask(fire({ scheduleTaskId: 'sch-6' }), second.deps);
  expect(second.deps.createSession).not.toHaveBeenCalled();

  admit();
  await pending;
  const third = makeDeps();
  await fireScheduledTask(fire({ scheduleTaskId: 'sch-6' }), third.deps);
  expect(third.deps.createSession).toHaveBeenCalledTimes(1);
});

test('a session adopted by a reply runs as an ordinary user turn again', () => {
  expect(conversationTrigger({ origin: 'direct', scheduleId: 'sch-4' }))
    .toEqual({ trigger: 'user', executionKind: 'local', scheduleTaskId: null });
  expect(conversationTrigger(null)).toEqual({ trigger: 'user', executionKind: 'local', scheduleTaskId: null });
});
