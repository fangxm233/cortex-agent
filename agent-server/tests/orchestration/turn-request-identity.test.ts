// Every surface that opens a turn on a session's live engine — a user message, an edit retry, an
// ask-user answer — and manual compaction, which runs a command on it, must ask for the same engine.
// The pool compares the spec identity and respawns on any difference, so a surface that built its
// own spec used to kill the session's process and resume it without the agent's plugins, tools or
// worker tools. The spec is built the way the run builds it, route included, with the gateway up:
// the gateway route names the run's project and trigger, and the route is part of the identity.
// Compaction follows the materialized session choice even if an older engine remains pooled.
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
    resolveBackendForChannel: () => 'claude',
  };
});

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-identity-plugin-'));

vi.mock('@domain/agents/environments/index.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    resolveEnvironmentByName: () => ({
      profile: 'retired-environment-field', // Old mocks cannot override the session selection.
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
import { requestRoute } from '../../src/domain/runs/config-resolver.js';
import { engines } from '../../src/domain/runs/engines.js';
import type { RunRequest } from '../../src/domain/runs/request.js';
import { _testSetHealthy } from '../../src/domain/costs/gateway-manager.js';
import type { EngineSession, EngineSpec } from '../../src/agent-adapter/types.js';
import { compactSessionContext } from '../../src/orchestration/session-compact.js';
import { claudeSpecIdentity } from '../../src/agent-adapter/claude/adapter.js';
import type { TurnInput } from '../../src/orchestration/turn/turn.js';
import { AgentRunner } from '../../src/orchestration/agent-runner.js';
import { runRetryAgent } from '../../src/orchestration/edit-retry.js';
import { resumeAskUserQuestionGroup } from '../../src/orchestration/interactions/ask-user-resume.js';
import { MockAdapter } from '../../src/platform/testing.js';
import { CLAUDE_SELECTION, seedSelections } from './selection-fixture.js';

const CHANNEL = 'web:lead';
const SESSION: Session = {
  sessionId: 'track-lead', backendSessionId: 'backend-lead', projectId: 'general',
  channel: CHANNEL, backend: 'claude', kind: 'local', origin: 'direct',
  createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-01T00:00:00.000Z',
  label: null, selection: { ...CLAUDE_SELECTION, thinking: 'high', mode: 'plan' },
} as Session;

beforeAll(() => {
  seedSelections();
  _testSetHealthy(true);
  fs.writeFileSync(path.join(CONFIG_DIR, 'settings.json'), JSON.stringify({ teamEnabled: true }));
  resetSettingsForTests();
});

beforeEach(() => {
  vi.restoreAllMocks();
  captured.length = 0;
  vi.spyOn(sessionStore, 'getById').mockResolvedValue(SESSION);
  vi.spyOn(sessionStore, 'getById').mockResolvedValue(SESSION);
  vi.spyOn(sessionUse, 'acquireSessionUse').mockResolvedValue(() => {});
  vi.spyOn(sessions, 'getSessionAsync').mockResolvedValue(SESSION.sessionId);
});

/** The spec is built directly from the request's materialized selection. */
function runSpec(request: RunRequest): EngineSpec {
  return buildEngineSpec(request, request.selection, { route: requestRoute(request, request.selection) });
}

async function identityOf(input: TurnInput): Promise<string> {
  const { request } = await input.prepareRequest(input.session);
  return claudeSpecIdentity(runSpec(request));
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
    sessionId: SESSION.sessionId, session: SESSION, userMessageTs: 'M1', retryPrefix: '', turnTrackingToken: 'token' as any,
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

/** Compact the session against a pool holding `live` (or nothing), returning the specs asked for. */
async function compactAgainst(live: EngineSession | null): Promise<EngineSpec[]> {
  const acquired: EngineSpec[] = [];
  const engine = live ?? {
    compact: async () => ({
      status: 'not-needed', tokensBefore: null, estimatedTokensAfter: null, contextUsage: null, usage: null,
    }),
  } as unknown as EngineSession;
  vi.spyOn(engines, 'get').mockReturnValue((live ?? undefined) as never);
  vi.spyOn(engines, 'acquire').mockImplementation(((spec: EngineSpec) => {
    acquired.push(spec);
    return engine;
  }) as never);
  const outcome = await compactSessionContext(SESSION.sessionId);
  expect(outcome.ok).toBe(true);
  return acquired;
}

test('manual compaction asks for the same engine as a user turn', async () => {
  const userTurn = await userTurnIdentity();
  const acquired = await compactAgainst(null);
  expect(acquired).toHaveLength(1);
  expect(acquired[0].resume.backendSessionId).toBe(SESSION.backendSessionId);
  expect(claudeSpecIdentity(acquired[0])).toBe(userTurn);
});

test('manual compaction uses the session selection instead of a stale pooled engine choice', async () => {
  const userTurn = await userTurnIdentity();
  const { request } = await captured.at(-1)!.prepareRequest(captured.at(-1)!.session);
  expect(request.selection).toEqual(SESSION.selection);
  const staleTurn = claudeSpecIdentity(runSpec({ ...request, selection: { ...request.selection, mode: 'api' } }));
  expect(staleTurn).not.toBe(userTurn);
  const live = {
    backend: 'claude', identity: staleTurn, backendSessionId: SESSION.backendSessionId, isAlive: () => true,
    compact: async () => ({
      status: 'not-needed', tokensBefore: null, estimatedTokensAfter: null, contextUsage: null, usage: null,
    }),
  } as unknown as EngineSession;
  const acquired = await compactAgainst(live);
  expect(acquired).toHaveLength(1);
  expect(claudeSpecIdentity(acquired[0])).toBe(userTurn);
});
