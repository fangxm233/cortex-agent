import { beforeEach, expect, test, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';
import { applyChannelSelection } from '../../../src/domain/agents/model-selection.js';
import { getChannelSelection, setChannelSelection } from '../../../src/domain/agents/config.js';
import { modelsRepo } from '../../../src/store/models-repo.js';
import { REGISTRY_FILE, SessionRegistryRepo, sessionStore } from '../../../src/store/session-registry-repo.js';

vi.mock('../../../src/core/gateway-generator.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/gateway-generator.js')>(),
  readGatewayYaml: () => null,
}));

const claude: EngineSelection = { backend: 'claude', provider: null, model: 'opus', thinking: null, mode: 'api' };
const pi: EngineSelection = { backend: 'pi', provider: 'openai', model: 'gpt', thinking: null, mode: 'api' };
const channel = 'web:backend-identity';
const sessionId = 'backend-identity';

beforeEach(async () => {
  writeFileSync(path.join(process.env.CORTEX_HOME!, 'config/models.json'), JSON.stringify({ default: claude, favorites: [pi] }));
  modelsRepo.invalidate();
  setChannelSelection(channel, claude);
  await sessionStore.registerSession({ sessionId, channel, backend: 'claude', kind: 'local', selection: claude });
  await sessionStore.bindChannel(channel, sessionId);
});

test('a history-free switch journals backend and selection together and locks resumes to that identity', async () => {
  const before = readFileSync(REGISTRY_FILE, 'utf8').length;
  expect(await applyChannelSelection({ channel, ...pi })).toMatchObject({ ok: true, backendChanged: true });
  const writes = readFileSync(REGISTRY_FILE, 'utf8').slice(before).trim().split('\n');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]).fields).toMatchObject({ backend: 'pi', selection: pi });
  expect(await new SessionRegistryRepo(REGISTRY_FILE).getById(sessionId))
    .toMatchObject({ backend: 'pi', selection: pi, backendSessionId: null });

  await sessionStore.updateSession(sessionId, { backendSessionId: 'pi-resume' });
  expect(await sessionStore.getTurns(channel)).toEqual([]);
  expect(await applyChannelSelection({ channel, ...claude })).toMatchObject({
    ok: false, reason: 'cross-backend-live-session', currentBackend: 'pi', targetBackend: 'claude',
  });
  expect(getChannelSelection(channel)).toEqual(pi);
  expect(await sessionStore.getById(sessionId)).toMatchObject({ backend: 'pi', selection: pi, backendSessionId: 'pi-resume' });
});

test.each(['claude-resume', undefined])('recorded backend wins over inconsistent legacy selection (resume: %s)', async (backendSessionId) => {
  await sessionStore.updateById(sessionId, (record) => ({ ...record, selection: pi, backendSessionId }));
  const before = readFileSync(REGISTRY_FILE, 'utf8');
  expect(await sessionStore.getTurns(channel)).toEqual([]);
  expect(await applyChannelSelection({ channel, ...pi })).toMatchObject({
    ok: false, reason: 'cross-backend-live-session', currentBackend: 'claude', targetBackend: 'pi',
  });
  expect(readFileSync(REGISTRY_FILE, 'utf8')).toBe(before);
  expect(getChannelSelection(channel)).toEqual(claude);
});
