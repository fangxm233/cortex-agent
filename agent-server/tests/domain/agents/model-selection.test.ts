import { beforeEach, expect, test, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { importWithFreshRegistry } from '../../helpers/fresh-module.js';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';

vi.mock('@core/log.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

const HOME = process.env.CORTEX_HOME!;
const STATE = path.join(HOME, 'data/agent-state.json');
const claude: EngineSelection = { backend: 'claude', provider: null, model: 'opus', thinking: 'medium', mode: 'plan' };
const pi: EngineSelection = { backend: 'pi', provider: 'deepseek', model: 'flash', thinking: null, mode: 'deepseek' };
const gateway = { endpoints: { anthropic: { api: {}, plan: {} }, deepseek: { deepseek: {} }, other: { other: {} } } } as never;
let turns = 0;
let session: { sessionId: string; backend: string; backendSessionId?: string | null; selection?: EngineSelection } | null;
let patches: unknown[] = [];
let syncFailure = false;
vi.mock('@store/session-registry-repo.js', async (importOriginal) => ({
  effectiveBackendSessionId: (await importOriginal<typeof import('../../../src/store/session-registry-repo.js')>()).effectiveBackendSessionId,
  sessionStore: {
    getTurns: async () => Array(turns).fill({}),
    getBoundSessionId: async () => session?.sessionId ?? null,
    getById: async () => session,
    updateSession: async (_id: string, patch: { backend: string; selection: EngineSelection }) => {
      if (syncFailure) throw new Error('journal unavailable');
      patches.push(patch);
      if (session) session = { ...session, ...patch };
    },
  },
}));
vi.mock('../../../src/core/gateway-generator.js', () => ({ readGatewayYaml: () => gateway }));
vi.mock('../../../src/agent-adapter/pi/discovery.js', () => ({ piProviderDiscovery: { peekModels: () => [] } }));
const fresh = () => importWithFreshRegistry(() => import('../../../src/domain/agents/model-selection.js'));
const stored = () => JSON.parse(readFileSync(STATE, 'utf8'));
function seed(state: Record<string, unknown> = {}) { writeFileSync(STATE, JSON.stringify(state)); }
beforeEach(() => {
  turns = 0; patches = []; syncFailure = false;
  session = { sessionId: 's1', backend: 'claude', backendSessionId: null, selection: claude };
  writeFileSync(path.join(HOME, 'config/models.json'), JSON.stringify({ default: claude, favorites: [pi] }));
  seed();
});

test('read reports a complete default; model change writes channel, session, memory and web seed', async () => {
  const api = await fresh();
  expect(api.readChannelSelection('web:a')).toEqual(claude);
  const result = await api.applyChannelSelection({ channel: 'web:a', model: 'sonnet', thinking: 'xhigh' });
  const expected = { ...claude, model: 'sonnet', thinking: 'xhigh', mode: 'api' };
  expect(result).toEqual({ ...expected, ok: true, backendChanged: false });
  expect(stored().channelSelections['web:a']).toEqual(expected);
  expect(stored().modelMemory['["claude",null,"sonnet"]']).toEqual({ thinking: 'xhigh', mode: 'api' });
  expect(stored().selectionDefault).toEqual(expected);
  expect(patches).toEqual([{ backend: 'claude', selection: expected }]);
  expect((await fresh()).readChannelSelection('web:a')).toEqual(expected);
});

test('undefined leaves fields untouched and null thinking explicitly clears', async () => {
  seed({ channelSelections: { 'web:a': claude } });
  const api = await fresh();
  const result = await api.applyChannelSelection({ channel: 'web:a', model: undefined, thinking: null });
  expect(result).toEqual({ ...claude, thinking: null, ok: true, backendChanged: false });
  expect(stored().modelMemory['["claude",null,"opus"]']).toEqual({ thinking: null, mode: 'plan' });
});

test('new model loads its own memory, not the previous model settings', async () => {
  seed({ modelMemory: { '["claude",null,"sonnet"]': { thinking: 'low', mode: 'api' } } });
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', model: 'sonnet' }))
    .toMatchObject({ thinking: 'low', mode: 'api' });
  expect(await api.applyChannelSelection({ channel: 'web:a', model: 'haiku' }))
    .toMatchObject({ thinking: null, mode: 'api' });
  expect(await api.applyChannelSelection({ channel: 'web:a', model: 'sonnet', thinking: null, mode: 'plan' }))
    .toMatchObject({ thinking: null, mode: 'plan' });
});

test('switching back restores the last explicit choice including null thinking', async () => {
  const api = await fresh();
  await api.applyChannelSelection({ channel: 'web:a', thinking: null, mode: 'api' });
  await api.applyChannelSelection({ channel: 'web:a', model: 'sonnet', thinking: 'high', mode: 'plan' });
  expect(await api.applyChannelSelection({ channel: 'web:a', model: 'opus' }))
    .toMatchObject({ thinking: null, mode: 'api' });
});

test('a complete selection overrides memory, including an explicit reset to the default', async () => {
  seed({ modelMemory: { '["claude",null,"opus"]': { thinking: 'low', mode: 'api' } } });
  const api = await fresh();
  await api.applyChannelSelection({ channel: 'web:a', model: 'sonnet' });
  expect(await api.applyChannelSelection({ channel: 'web:a', ...claude }))
    .toEqual({ ...claude, ok: true, backendChanged: false });
});

test('live history rejects a backend change without any persistence', async () => {
  turns = 3;
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', ...pi }))
    .toMatchObject({ ...claude, ok: false, reason: 'cross-backend-live-session', currentBackend: 'claude', targetBackend: 'pi' });
  expect(stored()).toEqual({});
  expect(patches).toEqual([]);
});

test('the live session backend is authoritative even when the channel map is stale', async () => {
  turns = 1;
  seed({ channelSelections: { 'web:a': pi } });
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', ...pi, model: 'another-pi' }))
    .toMatchObject({ ok: false, reason: 'cross-backend-live-session' });
});

test.each(['backend-claude-id', undefined])('resumed session with durable backend ID %s rejects switching despite an empty ledger', async (backendSessionId) => {
  session = { ...session!, backendSessionId };
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:resumed', ...pi }))
    .toMatchObject({ ok: false, reason: 'cross-backend-live-session', currentBackend: 'claude', targetBackend: 'pi' });
  expect(stored()).toEqual({});
  expect(patches).toEqual([]);
});

test('partial edits after a cross-channel resume use the bound session, not stale channel settings', async () => {
  const resumed = { ...claude, model: 'sonnet', thinking: 'high', mode: 'api' };
  session = { ...session!, selection: resumed, backendSessionId: 'claude-resumed' };
  seed({ channelSelections: { 'web:old': claude, 'web:resumed': claude } });
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:resumed', thinking: 'xhigh' }))
    .toEqual({ ...resumed, thinking: 'xhigh', ok: true, backendChanged: false });
  expect(stored().channelSelections['web:resumed']).toEqual({ ...resumed, thinking: 'xhigh' });
  expect(stored().channelSelections['web:old']).toEqual(claude);
  expect(patches).toEqual([{ backend: 'claude', selection: { ...resumed, thinking: 'xhigh' } }]);
});

test('a fresh session may change backend and updates the session selection', async () => {
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', ...pi }))
    .toEqual({ ...pi, ok: true, backendChanged: true });
  expect(patches).toEqual([{ backend: 'pi', selection: pi }]);
});

test('backend-only change uses that backend default; missing favorites refuses', async () => {
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', backend: 'pi' }))
    .toMatchObject(pi);
  writeFileSync(path.join(HOME, 'config/models.json'), JSON.stringify({ default: claude, favorites: [] }));
  const empty = await fresh();
  seed();
  expect(await empty.applyChannelSelection({ channel: 'web:b', backend: 'pi' }))
    .toMatchObject({ ok: false, reason: 'no-model-for-backend' });
});

test.each([false, true])('backend-only pick preserves all configured default settings (same backend: %s)', async (sameBackend) => {
  const current = sameBackend ? { ...claude, model: 'sonnet', thinking: 'low', mode: 'api' } : pi;
  session = { ...session!, selection: current, backend: current.backend };
  seed({ channelSelections: { 'web:a': current }, modelMemory: { '["claude",null,"opus"]': { thinking: 'low', mode: 'api' } } });
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', backend: 'claude' }))
    .toEqual({ ...claude, ok: true, backendChanged: !sameBackend });
  expect(stored().channelSelections['web:a']).toEqual(claude);
});

test('backend-only pick without memory preserves default thinking and route, while explicit model loads memory', async () => {
  session = { ...session!, selection: pi, backend: 'pi' };
  seed({ channelSelections: { 'web:a': pi } });
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', backend: 'claude' }))
    .toMatchObject({ ...claude, ok: true });
  await api.applyChannelSelection({ channel: 'web:a', ...pi });
  expect(await api.applyChannelSelection({ channel: 'web:a', backend: 'claude', model: 'opus', thinking: 'low', mode: 'api' }))
    .toMatchObject({ thinking: 'low', mode: 'api', ok: true });
  await api.applyChannelSelection({ channel: 'web:a', ...pi });
  expect(await api.applyChannelSelection({ channel: 'web:a', backend: 'claude', model: 'opus' }))
    .toMatchObject({ thinking: 'low', mode: 'api', ok: true });
});

test('target backend thinking is validated before any write', async () => {
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', ...pi, thinking: 'ultra' }))
    .toMatchObject({ ok: false, reason: 'invalid-thinking', allowed: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] });
  expect(stored()).toEqual({});
  expect(patches).toEqual([]);
});

test('invalid provider, model and mode are refused without mutation', async () => {
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', provider: 'deepseek' }))
    .toMatchObject({ reason: 'provider-not-supported' });
  expect(await api.applyChannelSelection({ channel: 'web:a', model: '' })).toMatchObject({ reason: 'invalid-model' });
  expect(await api.applyChannelSelection({ channel: 'web:a', mode: 'absent' }))
    .toMatchObject({ reason: 'invalid-mode', allowed: ['api', 'plan'] });
  expect(stored()).toEqual({});
});

test('route check uses the target provider and rejects invalid remembered modes too', async () => {
  seed({ modelMemory: { '["pi","other","model"]': { thinking: null, mode: 'deepseek' } } });
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', backend: 'pi', provider: 'other', model: 'model' }))
    .toMatchObject({ reason: 'invalid-mode', allowed: ['other'] });
  expect(await api.applyChannelSelection({ channel: 'web:a', backend: 'pi', provider: 'other', model: 'model', mode: 'other' }))
    .toMatchObject({ ok: true, provider: 'other', mode: 'other' });
});

test('unreadable gateway permits a safe route; injected gateway controls first Claude route', async () => {
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', mode: 'custom', readGateway: () => null }))
    .toMatchObject({ ok: true, mode: 'custom' });
  const injected = { endpoints: { anthropic: { custom: {} } } } as never;
  expect(await api.applyChannelSelection({ channel: 'web:a', model: 'new', readGateway: () => injected }))
    .toMatchObject({ ok: true, mode: 'custom' });
});

test('changing provider resets settings and subsequent model picks keep that provider', async () => {
  seed({ channelSelections: { 'web:a': pi } });
  session = null;
  const api = await fresh();
  expect(await api.applyChannelSelection({ channel: 'web:a', provider: 'other' }))
    .toMatchObject({ ok: true, provider: 'other', mode: 'other', thinking: null });
  expect(await api.applyChannelSelection({ channel: 'web:a', model: 'new' }))
    .toMatchObject({ ok: true, provider: 'other', mode: 'other' });
});

test('platform picks and seedDefault false do not change the new-conversation seed', async () => {
  seed({ selectionDefault: { ...claude, agentName: 'creative' } });
  const api = await fresh();
  await api.applyChannelSelection({ channel: 'slack:a', thinking: 'max' });
  await api.applyChannelSelection({ channel: 'web:worker', model: 'haiku', seedDefault: false });
  expect(stored().selectionDefault).toEqual({ ...claude, agentName: 'creative' });
  await api.applyChannelSelection({ channel: 'web:a', model: 'sonnet' });
  expect(stored().selectionDefault.agentName).toBe('creative');
});

test('concurrent partial updates merge rather than losing either choice', async () => {
  const api = await fresh();
  await Promise.all([
    api.applyChannelSelection({ channel: 'web:a', thinking: 'xhigh' }),
    api.applyChannelSelection({ channel: 'web:a', mode: 'api' }),
  ]);
  expect(api.readChannelSelection('web:a')).toEqual({ ...claude, thinking: 'xhigh', mode: 'api' });
});

test('session write failure is surfaced before channel, memory or seed writes', async () => {
  syncFailure = true;
  const api = await fresh();
  await expect(api.applyChannelSelection({ channel: 'web:a', model: 'sonnet' })).rejects.toThrow('journal unavailable');
  expect(stored()).toEqual({});
});
