import { beforeEach, expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import { setChannelSelection } from '../../../src/domain/agents/config.js';
import { modelsRepo } from '../../../src/store/models-repo.js';
import { effectiveBackendSessionId, sessionStore } from '../../../src/store/session-registry-repo.js';
import { resolveRunSelection } from '../../../src/domain/runs/config-resolver.js';
import { conversationEngineRequest } from '../../../src/orchestration/conversation-request.js';

vi.mock('../../../src/domain/agents/environments/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/domain/agents/environments/index.js')>(),
  resolveEnvironmentByName: () => ({ systemPrompt: 'test', promptTemplate: '{{input}}' }),
}));

const claude: EngineSelection = { backend: 'claude', provider: null, model: 'opus', thinking: null, mode: 'api' };
const pi: EngineSelection = { backend: 'pi', provider: 'openai', model: 'gpt', thinking: null, mode: 'api' };
const channel = 'web:resume-guard';

beforeEach(() => {
  writeFileSync(path.join(process.env.CORTEX_HOME!, 'config/models.json'), JSON.stringify({ default: pi, favorites: [] }));
  modelsRepo.invalidate();
  setChannelSelection(channel, null);
});

async function recordedSession(backendSessionId: string | null | undefined) {
  await sessionStore.registerSession({
    sessionId: 'resume-guard', channel, backend: 'claude', kind: 'local', backendSessionId,
  });
  // Legacy records without backendSessionId resume by their Cortex session ID.
  if (backendSessionId === undefined) await sessionStore.updateById('resume-guard', (record) => {
    delete record.backendSessionId;
    return record;
  });
  return (await sessionStore.getById('resume-guard'))!;
}

function requestFor(session: Awaited<ReturnType<typeof recordedSession>>) {
  return conversationEngineRequest({
    channel, session,
    ids: { sessionId: session.sessionId, backendSessionId: effectiveBackendSessionId(session), projectId: 'general' },
  });
}

test.each([
  ['channel', 'claude-resume'], ['default', 'claude-resume'],
  ['channel', undefined], ['default', undefined],
] as const)('request construction refuses a %s backend mismatch before an engine can spawn (resume: %s)', async (source, resumeId) => {
  if (source === 'channel') setChannelSelection(channel, pi);
  const session = await recordedSession(resumeId);
  expect(session.selection).toBeNull();
  expect(() => requestFor(session)).toThrow(/cannot resume.*claude.*pi/i);
});

test('same-backend resume preserves its ID, while a history-free session may inherit another backend', async () => {
  setChannelSelection(channel, claude);
  const resumed = requestFor(await recordedSession('claude-resume'));
  expect(resumed.selection).toEqual(claude);
  expect(resumed.session.backendSessionId).toBe('claude-resume');
  setChannelSelection(channel, pi);
  const fresh = requestFor(await recordedSession(null));
  expect(fresh.selection).toEqual(pi);
  expect(fresh.session.backendSessionId).toBeNull();
});

test('neither an explicit override nor inconsistent recorded selection can override the resume backend', async () => {
  const session = await recordedSession('claude-resume');
  expect(() => resolveRunSelection({ session, selection: pi })).toThrow(/cannot resume.*claude.*pi/i);
  expect(() => requestFor({ ...session, selection: pi })).toThrow(/cannot resume.*claude.*pi/i);
});
