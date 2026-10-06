// Every surface that opens a turn on a session's live engine — a user message, an edit retry, an
// ask-user answer — must ask for the same engine. The pool compares the spec identity and respawns
// on any difference, so a surface that built its own spec used to kill the session's process and
// resume it without the agent's plugins, tools or worker tools for that turn.
import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { captured } = vi.hoisted(() => ({ captured: [] as Array<import('../../src/orchestration/turn/turn.js').TurnInput> }));

vi.mock('../../src/orchestration/turn/turn.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, openTurn: async (input: import('../../src/orchestration/turn/turn.js').TurnInput) => { captured.push(input); } };
});

vi.mock('@domain/agents/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getDefaultAgent: () => 'main',
    getActiveProfile: () => 'scan',
    resolveBackendForChannel: () => 'claude',
  };
});

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-identity-plugin-'));

vi.mock('@domain/agents/environments/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    resolveEnvironmentByName: () => ({
      profile: '__active__',
      systemPrompt: 'You are the main agent.',
      promptTemplate: '{{input}}',
      tools: 'Bash,Read,Skill',
      pluginDirs: [pluginDir],
    }),
  };
});

import { CONFIG_DIR } from '../../src/core/paths.js';
import { resetSettingsForTests } from '../../src/core/settings.js';
import { sessionStore, type Session } from '../../src/store/session-registry-repo.js';
import { sessionUse } from '../../src/domain/sessions/session-use.js';
import * as sessions from '../../src/domain/sessions/session.js';
import { buildEngineSpec } from '../../src/domain/runs/engine-spec.js';
import { claudeSpecIdentity } from '../../src/agent-adapter/claude/adapter.js';
import type { TurnInput } from '../../src/orchestration/turn/turn.js';
import { AgentRunner } from '../../src/orchestration/agent-runner.js';
import { runRetryAgent } from '../../src/orchestration/edit-retry.js';
import { resumeAskUserQuestionGroup } from '../../src/orchestration/interactions/ask-user-resume.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { seedTestProfiles } from '../_seed-profiles.js';

const CHANNEL = 'web:lead';
const SESSION: Session = {
  name: 'cortex-lead', sessionId: 'track-lead', backendSessionId: 'backend-lead', projectId: 'general',
  channel: CHANNEL, backend: 'claude', kind: 'local', origin: 'direct',
  createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-01T00:00:00.000Z',
  label: null, profileName: 'scan',
} as Session;

beforeAll(() => {
  seedTestProfiles();
  fs.writeFileSync(path.join(CONFIG_DIR, 'settings.json'), JSON.stringify({ teamEnabled: true }));
  resetSettingsForTests();
});

beforeEach(() => {
  vi.restoreAllMocks();
  captured.length = 0;
  vi.spyOn(sessionStore, 'getById').mockResolvedValue(SESSION);
  vi.spyOn(sessionStore, 'lookupBySessionId').mockResolvedValue(SESSION.name);
  vi.spyOn(sessionUse, 'acquireSessionUse').mockResolvedValue(() => {});
  vi.spyOn(sessions, 'getSessionAsync').mockResolvedValue(SESSION.sessionId);
});

async function identityOf(input: TurnInput): Promise<string> {
  const { request } = await input.prepareRequest(input.session);
  return claudeSpecIdentity(buildEngineSpec(request, request.profile));
}

async function userTurnIdentity(): Promise<string> {
  const runner = new AgentRunner({ tryInject: async () => false, track: () => {} });
  const message = { ref: { conduit: CHANNEL, messageId: 'M1', threadId: null }, text: 'hello', isBot: false, files: [] };
  await (runner as any)._executeReal({
    message, channel: CHANNEL, adapter: new MockAdapter(), threadAnchorId: null,
    hasFiles: false, userMessage: 'hello', agentMessage: 'hello',
  }, () => {}, async () => ({ files: [], failures: [] }));
  return identityOf(captured.at(-1)!);
}

test('the user turn opens the agent\'s engine: its plugins and the lead\'s worker tools', async () => {
  const identity = JSON.parse(await userTurnIdentity()) as Array<[string, unknown]>;
  const fields = new Map(identity);
  expect(fields.get('tools')).toBe('Bash,Read,Skill');
  expect(fields.get('pluginDirs')).toEqual([fs.realpathSync(pluginDir)]);
  expect(fields.get('teamLead')).toBe(true);
});

test('an edit retry asks for the same engine as a user turn', async () => {
  const userTurn = await userTurnIdentity();
  await runRetryAgent({
    channel: CHANNEL, text: 'edited', adapter: new MockAdapter() as any,
    statusMsg: { conduit: CHANNEL, messageId: 'status' }, startTime: Date.now(),
    sessionId: SESSION.sessionId, session: SESSION, sessionName: SESSION.name,
    userMessageTs: 'M1', retryPrefix: '', turnTrackingToken: 'token' as any,
  });
  expect(await identityOf(captured.at(-1)!)).toBe(userTurn);
});

test('an ask-user answer asks for the same engine as a user turn', async () => {
  const userTurn = await userTurnIdentity();
  await resumeAskUserQuestionGroup({
    adapter: new MockAdapter() as any,
    group: { channel: CHANNEL, sessionId: SESSION.sessionId, groupId: 'group-1' },
    responseText: 'answer',
  });
  expect(await identityOf(captured.at(-1)!)).toBe(userTurn);
});
